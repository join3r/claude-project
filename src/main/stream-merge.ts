import type { ProjectsData, StreamMergeResult } from '../shared/types'
import { taskWorktreesSupported } from '../shared/streams'
import { gitErrorText, gitOutput, type GitRunner } from './git-runner'

/**
 * Merging a closing stream's branch into its base branch (the one it was cut
 * from), as a merge commit even when a fast-forward would do, so the stream's
 * commits stay together on the base branch.
 *
 * The merge is made without a checkout (`merge-tree --write-tree`, then
 * `commit-tree`), so a conflict leaves nothing half-merged. The base branch
 * then moves to the merge commit: a fast-forward in the worktree that has it
 * checked out (git refuses one that would overwrite local changes), or a
 * compare-and-swap `update-ref` when no worktree has it. A base branch that
 * moved in between means another round.
 *
 * Only committed work is merged; the stream's uncommitted changes are left in
 * its worktree for the caller to deal with.
 */

export interface StreamMergeDeps {
  projects: { peek(): ProjectsData }
  runner: GitRunner
  log?(message: string): void
  maxAttempts?: number
}

const MAX_ATTEMPTS = 3
/** `merge-tree` and a fast-forward can take a while in a big repo. */
const LONG_GIT_MS = 60_000
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'] as const

function splitNul(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

export async function mergeStream(deps: StreamMergeDeps, projectId: string, streamId: string): Promise<StreamMergeResult> {
  const project = deps.projects.peek().projects.find(p => p.id === projectId)
  const stream = project?.streams.find(candidate => candidate.id === streamId)
  if (!project || !stream) return { status: 'failed', error: 'No such stream' }
  if (stream.isMain || !stream.workspace) return { status: 'failed', error: 'This stream has no branch of its own' }
  if (!taskWorktreesSupported(project)) return { status: 'failed', error: 'Merging is not supported for SSH projects yet' }
  const { worktreePath: cwd, branchName: branch, baseBranch: base } = stream.workspace
  const git = (args: readonly string[], timeoutMs?: number) => gitOutput(deps.runner, args, { cwd, timeoutMs })
  const tip = async (name: string): Promise<string | null> => {
    const result = await deps.runner.run(['rev-parse', '--verify', '-q', `refs/heads/${name}`], { cwd })
    return result.code === 0 ? result.stdout.trim() : null
  }

  try {
    const streamTip = await tip(branch)
    if (!streamTip) return { status: 'failed', error: `Branch "${branch}" is gone` }
    const attempts = deps.maxAttempts ?? MAX_ATTEMPTS
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const baseTip = await tip(base)
      if (!baseTip) return { status: 'failed', error: `"${base}" is not a local branch` }
      const contained = await deps.runner.run(['merge-base', '--is-ancestor', streamTip, baseTip], { cwd })
      if (contained.code === 0) return { status: 'nothing' }

      const tree = await deps.runner.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', baseTip, streamTip], { cwd, timeoutMs: LONG_GIT_MS })
      if (tree.code === 1) return { status: 'conflict', files: splitNul(tree.stdout).slice(1) }
      if (tree.code !== 0) return { status: 'failed', error: gitErrorText(['merge-tree'], tree) }
      const treeId = splitNul(tree.stdout)[0]
      const message = `Merge stream "${stream.name}" (${branch}) into ${base}`
      const merge = (await git(['commit-tree', treeId, '-p', baseTip, '-p', streamTip, '-m', message])).trim()

      const checkout = await worktreeOn(deps.runner, cwd, base)
      if (!checkout) {
        const moved = await deps.runner.run(['update-ref', '-m', message, `refs/heads/${base}`, merge, baseTip], { cwd })
        if (moved.code === 0) {
          deps.log?.(`stream merge stream=${stream.id} merged ${branch} into ${base}`)
          return { status: 'merged' }
        }
        if ((await tip(base)) === baseTip) return { status: 'failed', error: gitErrorText(['update-ref'], moved) }
        continue
      }
      const ff = await deps.runner.run([...NO_HOOKS, 'merge', '--ff-only', '--no-verify-signatures', merge], { cwd: checkout, timeoutMs: LONG_GIT_MS })
      if (ff.code === 0) {
        deps.log?.(`stream merge stream=${stream.id} merged ${branch} into ${base} at ${checkout}`)
        return { status: 'merged' }
      }
      if ((await tip(base)) !== baseTip) continue
      // Not moved, so git refused over the checkout: name the files in the way.
      const dirty = new Set(splitNul(await gitOutput(deps.runner, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: checkout }))
        .map(entry => entry.slice(3)))
      const touched = splitNul(await git(['diff', '--name-only', '-z', baseTip, merge]))
      return { status: 'blocked', files: touched.filter(file => dirty.has(file)), message: gitErrorText(['merge'], ff) }
    }
    return { status: 'failed', error: `${base} kept moving while the stream was merging. Try again.` }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    deps.log?.(`stream merge stream=${stream.id} error=${error}`)
    return { status: 'failed', error }
  }
}

/** The worktree that has `branch` checked out, or null. */
async function worktreeOn(runner: GitRunner, cwd: string, branch: string): Promise<string | null> {
  const out = await gitOutput(runner, ['worktree', 'list', '--porcelain', '-z'], { cwd })
  let current: string | null = null
  for (const line of splitNul(out)) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}` && current) return current
  }
  return null
}

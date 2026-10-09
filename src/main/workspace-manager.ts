import path from 'path'
import fs from 'fs'
import type { WorkspaceDeleteResult, WorkspaceRestoreResult } from '../shared/types'
import { GitError, gitOutput, LocalGitRunner, type GitRunner } from './git-runner'
import { runWorktreeSetup, type WorktreeSetupResult } from './worktree-setup'
import { MemorySetupApprovals, type SetupApprovals } from './worktree-setup-approvals'

function errorText(err: unknown): string {
  const stderr = (err as { stderr?: string } | null)?.stderr
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  return err instanceof Error ? err.message : String(err)
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * Same folder, one spelling. On Windows Git may print 8.3 (`RUNNER~1`) while
 * Node `mkdtemp`/`realpathSync` keep `runneradmin`; `path.relative` then walks
 * out and back. Prefer the native realpath (long path) on both sides.
 */
export function canonicalFilePath(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return realpathOrSelf(target)
  }
}

export interface WorkspaceCreateOptions {
  /**
   * Checkout `.devtool/worktree.json` and its symlinked/copied files come
   * from. Defaults to the repo root (a stream worktree); a task worktree
   * passes its stream's worktree.
   */
  setupSource?: string
}

export interface CreatedWorktree {
  worktreePath: string
  branchName: string
  relativeProjectPath: string
  /** The repo's worktree setup. Whatever it says, the worktree exists and is kept. */
  setup: WorktreeSetupResult
}

export interface WorkspaceManagerOptions {
  runner?: GitRunner
  /** Which repo configs may run `setup` commands. Default: none survive the process. */
  approvals?: SetupApprovals
}

/** Local git worktrees, through a {@link GitRunner}. SSH projects use RemoteWorkspaceManager. */
export class WorkspaceManager {
  private readonly runner: GitRunner
  private readonly approvals: SetupApprovals

  constructor(options: WorkspaceManagerOptions = {}) {
    this.runner = options.runner ?? new LocalGitRunner()
    this.approvals = options.approvals ?? new MemorySetupApprovals()
  }

  /** stdout of a git call that must succeed; throws a {@link GitError} with git's stderr. */
  private git(cwd: string, args: string[], timeoutMs = 5000): Promise<string> {
    return gitOutput(this.runner, args, { cwd, timeoutMs })
  }

  private async getRepoRoot(projectDir: string): Promise<string> {
    const stdout = await this.git(projectDir, ['rev-parse', '--show-toplevel'])
    return canonicalFilePath(stdout.trim())
  }

  async listBranches(projectDir: string): Promise<string[]> {
    const repoRoot = await this.getRepoRoot(projectDir)
    const stdout = await this.git(repoRoot, ['branch', '--format=%(refname:short)'])
    return stdout.trim().split('\n').filter(Boolean)
  }

  /**
   * A worktree at `<repoRoot>/.worktrees/<name>` on a new branch `name` off
   * `baseBranch`, then the repo's worktree setup. A failed or unapproved
   * setup does not fail the create: it comes back in `setup` next to the new
   * worktree.
   */
  async create(projectDir: string, name: string, baseBranch: string, options: WorkspaceCreateOptions = {}): Promise<CreatedWorktree> {
    const repoRoot = await this.getRepoRoot(projectDir)

    // Validate branch name
    const valid = await this.runner.run(['check-ref-format', '--branch', name], { cwd: repoRoot, timeoutMs: 5000 })
    if (valid.code !== 0) throw new Error(`Invalid branch name: "${name}"`)

    const worktreePath = path.join(repoRoot, '.worktrees', name)

    // Create worktree with new branch
    const added = await this.runner.run(['worktree', 'add', worktreePath, '-b', name, baseBranch], { cwd: repoRoot, timeoutMs: 10000 })
    if (added.code !== 0) {
      const msg = new GitError(['worktree', 'add'], added).message
      if (msg.includes('already exists')) {
        throw new Error(`Branch "${name}" already exists`)
      }
      throw new Error(`Failed to create workspace: ${msg}`)
    }

    // Compute relative project path
    const rel = path.relative(repoRoot, canonicalFilePath(projectDir))
    const worktreeRoot = canonicalFilePath(worktreePath)

    const setup = await this.runSetup({ sourceRoot: options.setupSource ?? repoRoot, worktreeRoot, branch: name })

    return {
      worktreePath: worktreeRoot,
      branchName: name,
      relativeProjectPath: rel.split(path.sep).join('/'),
      setup
    }
  }

  /**
   * The repo's worktree setup on an existing worktree. Idempotent, so after
   * {@link approveSetup} this runs the commands a `needs-approval` result held back.
   */
  runSetup(request: { sourceRoot: string; worktreeRoot: string; branch: string }): Promise<WorktreeSetupResult> {
    return runWorktreeSetup({ ...request, runner: this.runner, approvals: this.approvals })
  }

  /** Lets this exact config content (`hash`, from a `needs-approval` result) run its commands in the repo `repoKey`. */
  approveSetup(repoKey: string, hash: string): void {
    this.approvals.approve(repoKey, hash)
  }

  /**
   * The worktree of an archived stream, back from its branch: `git worktree add
   * <path> <branch>` (no `-b`). A worktree still registered at `worktreePath` is
   * reused as is. `branch-missing` when the branch is gone (discarded on close).
   */
  async restore(projectDir: string, worktreePath: string, branchName: string): Promise<WorkspaceRestoreResult> {
    const repoRoot = await this.getRepoRoot(projectDir)
    const rel = path.relative(repoRoot, canonicalFilePath(projectDir)).split(path.sep).join('/')
    const registered = await this.listWorktreePaths(repoRoot)
    const target = realpathOrSelf(worktreePath)
    if (fs.existsSync(worktreePath) && registered.some(entry => realpathOrSelf(entry) === target)) {
      return { status: 'ok', worktreePath: canonicalFilePath(worktreePath), branchName, relativeProjectPath: rel }
    }
    const branch = await this.runner.run(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: repoRoot, timeoutMs: 5000 })
    if (branch.code !== 0) return { status: 'branch-missing' }
    const dest = fs.existsSync(worktreePath) ? path.join(repoRoot, '.worktrees', branchName) : worktreePath
    if (fs.existsSync(dest)) throw new Error(`Cannot restore the worktree: "${dest}" already exists`)
    // Metadata of a worktree whose folder is gone would block the add.
    await this.runner.run(['worktree', 'prune'], { cwd: repoRoot, timeoutMs: 5000 })
    try {
      await this.git(repoRoot, ['worktree', 'add', dest, branchName], 10000)
    } catch (err) {
      throw new Error(`Failed to restore the worktree: ${errorText(err)}`, { cause: err })
    }
    return { status: 'ok', worktreePath: canonicalFilePath(dest), branchName, relativeProjectPath: rel }
  }

  /** Absolute paths of every worktree git currently has registered for this repo. */
  private async listWorktreePaths(repoRoot: string): Promise<string[]> {
    const stdout = await this.git(repoRoot, ['worktree', 'list', '--porcelain'])
    return stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim())
      .filter(Boolean)
  }

  async delete(opts: {
    projectDir: string
    worktreePath: string
    branchName: string
    baseBranch: string
    force?: boolean
    keepBranch?: boolean
  }): Promise<WorkspaceDeleteResult> {
    const repoRoot = await this.getRepoRoot(opts.projectDir)

    if (!opts.force) {
      // Check for uncommitted changes. A check that cannot be completed is *not* proof the
      // worktree is clean, so it blocks deletion instead of allowing it.
      let hasUncommitted = false
      if (fs.existsSync(opts.worktreePath)) {
        try {
          const stdout = await this.git(opts.worktreePath, ['status', '--porcelain'])
          hasUncommitted = stdout.trim().length > 0
        } catch (err) {
          return {
            status: 'check-failed',
            reason: `Could not check "${opts.worktreePath}" for uncommitted changes: ${errorText(err)}`
          }
        }
      }

      // Check if branch is merged. Same rule: a renamed or deleted base branch makes
      // `git branch --merged` fail, and that must never read as "merged".
      let isUnmerged: boolean
      try {
        const stdout = await this.git(repoRoot, ['branch', '--merged', opts.baseBranch])
        const mergedBranches = stdout.split('\n').map(b => b.trim().replace(/^[*+] /, ''))
        isUnmerged = !mergedBranches.includes(opts.branchName)
      } catch (err) {
        return {
          status: 'check-failed',
          baseBranch: opts.baseBranch,
          reason: `Could not check whether "${opts.branchName}" is merged into "${opts.baseBranch}": ${errorText(err)}`
        }
      }

      if (hasUncommitted && isUnmerged) return { status: 'uncommitted-and-unmerged', baseBranch: opts.baseBranch }
      if (hasUncommitted) return { status: 'uncommitted' }
      if (isUnmerged) return { status: 'unmerged', baseBranch: opts.baseBranch }
    }

    // Remove worktree
    const removed = await this.runner.run(['worktree', 'remove', '--force', opts.worktreePath], { cwd: repoRoot, timeoutMs: 10000 })
    if (removed.code !== 0) {
      // `git worktree remove` refused. Before recursively deleting anything, prove the path is
      // really a worktree of this repo — a stale workspace record can point at a directory that
      // was removed and later reused for unrelated files.
      let registered: string[]
      try {
        registered = await this.listWorktreePaths(repoRoot)
      } catch (err) {
        return {
          status: 'check-failed',
          reason: `Could not list the worktrees of ${repoRoot}, so "${opts.worktreePath}" was left untouched: ${errorText(err)}`
        }
      }

      const target = realpathOrSelf(opts.worktreePath)
      const isRegistered = registered.some(entry => realpathOrSelf(entry) === target)

      if (isRegistered) {
        if (fs.existsSync(opts.worktreePath)) {
          fs.rmSync(opts.worktreePath, { recursive: true, force: true })
        }
      } else if (fs.existsSync(opts.worktreePath)) {
        return {
          status: 'invalid-worktree',
          reason: `"${opts.worktreePath}" is not a registered worktree of ${repoRoot}, so it was not deleted. Remove it by hand if it is no longer needed.`
        }
      }
      // Drop whatever stale worktree metadata git is still holding.
      await this.git(repoRoot, ['worktree', 'prune'])
    }

    // Remove branch unless keepBranch
    if (!opts.keepBranch) {
      // Branch may already be gone
      await this.runner.run(['branch', '-D', opts.branchName], { cwd: repoRoot, timeoutMs: 5000 })
    }

    return { status: 'ok' }
  }
}

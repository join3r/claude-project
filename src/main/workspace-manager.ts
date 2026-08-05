import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import type { WorkspaceDeleteResult } from '../shared/types'

const execFileAsync = promisify(execFile)

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

export class WorkspaceManager {
  private async getRepoRoot(projectDir: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectDir, timeout: 5000 })
    return fs.realpathSync(stdout.trim())
  }

  async listBranches(projectDir: string): Promise<string[]> {
    const repoRoot = await this.getRepoRoot(projectDir)
    const { stdout } = await execFileAsync('git', ['branch', '--format=%(refname:short)'], { cwd: repoRoot, timeout: 5000 })
    return stdout.trim().split('\n').filter(Boolean)
  }

  async create(projectDir: string, name: string, baseBranch: string): Promise<{ worktreePath: string; branchName: string; relativeProjectPath: string }> {
    const repoRoot = await this.getRepoRoot(projectDir)

    // Validate branch name
    try {
      await execFileAsync('git', ['check-ref-format', '--branch', name], { cwd: repoRoot, timeout: 5000 })
    } catch {
      throw new Error(`Invalid branch name: "${name}"`)
    }

    const worktreePath = path.join(repoRoot, '.worktrees', name)

    // Create worktree with new branch
    try {
      await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', name, baseBranch], { cwd: repoRoot, timeout: 10000 })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('already exists')) {
        throw new Error(`Branch "${name}" already exists`)
      }
      throw new Error(`Failed to create workspace: ${msg}`)
    }

    // Compute relative project path
    const rel = path.relative(repoRoot, fs.realpathSync(projectDir))

    return { worktreePath, branchName: name, relativeProjectPath: rel }
  }

  /** Absolute paths of every worktree git currently has registered for this repo. */
  private async listWorktreePaths(repoRoot: string): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { timeout: 5000 })
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
          const { stdout } = await execFileAsync('git', ['-C', opts.worktreePath, 'status', '--porcelain'], { timeout: 5000 })
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
      let isUnmerged = false
      try {
        const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'branch', '--merged', opts.baseBranch], { timeout: 5000 })
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
    try {
      await execFileAsync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', opts.worktreePath], { timeout: 10000 })
    } catch {
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
      await execFileAsync('git', ['-C', repoRoot, 'worktree', 'prune'], { timeout: 5000 })
    }

    // Remove branch unless keepBranch
    if (!opts.keepBranch) {
      try {
        await execFileAsync('git', ['-C', repoRoot, 'branch', '-D', opts.branchName], { timeout: 5000 })
      } catch {
        // Branch may already be gone
      }
    }

    return { status: 'ok' }
  }
}

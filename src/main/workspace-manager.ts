import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'

const execFileAsync = promisify(execFile)

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

  async delete(opts: {
    projectDir: string
    worktreePath: string
    branchName: string
    baseBranch: string
    force?: boolean
    keepBranch?: boolean
  }): Promise<{ status: 'ok' | 'uncommitted' | 'unmerged' | 'uncommitted-and-unmerged'; baseBranch?: string }> {
    const repoRoot = await this.getRepoRoot(opts.projectDir)

    if (!opts.force) {
      // Check for uncommitted changes
      let hasUncommitted = false
      try {
        const { stdout } = await execFileAsync('git', ['-C', opts.worktreePath, 'status', '--porcelain'], { timeout: 5000 })
        hasUncommitted = stdout.trim().length > 0
      } catch {
        hasUncommitted = false
      }

      // Check if branch is merged
      let isUnmerged = false
      try {
        const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'branch', '--merged', opts.baseBranch], { timeout: 5000 })
        const mergedBranches = stdout.split('\n').map(b => b.trim().replace(/^[*+] /, ''))
        isUnmerged = !mergedBranches.includes(opts.branchName)
      } catch {
        isUnmerged = false
      }

      if (hasUncommitted && isUnmerged) return { status: 'uncommitted-and-unmerged', baseBranch: opts.baseBranch }
      if (hasUncommitted) return { status: 'uncommitted' }
      if (isUnmerged) return { status: 'unmerged', baseBranch: opts.baseBranch }
    }

    // Remove worktree
    try {
      await execFileAsync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', opts.worktreePath], { timeout: 10000 })
    } catch {
      // If worktree remove fails, try manual cleanup
      if (fs.existsSync(opts.worktreePath)) {
        fs.rmSync(opts.worktreePath, { recursive: true, force: true })
      }
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

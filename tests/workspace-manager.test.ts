import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WorkspaceManager, canonicalFilePath } from '../src/main/workspace-manager'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'master', dir])
  // GitHub runners have no user.name/email; commits fail without a local identity.
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'])
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'])
}

describe('WorkspaceManager', () => {
  let manager: WorkspaceManager
  let repoDir: string

  beforeEach(() => {
    repoDir = canonicalFilePath(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-')))
    initGitRepo(repoDir)
    manager = new WorkspaceManager()
  })

  afterEach(() => {
    // Clean up any worktrees before removing the directory
    try {
      execFileSync('git', ['-C', repoDir, 'worktree', 'prune'])
    } catch {}
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  describe('listBranches', () => {
    it('returns branches for a git repo', async () => {
      const branches = await manager.listBranches(repoDir)
      expect(branches.length).toBeGreaterThan(0)
    })

    it('lists multiple branches', async () => {
      execFileSync('git', ['-C', repoDir, 'branch', 'feature-a'])
      const branches = await manager.listBranches(repoDir)
      expect(branches).toContain('feature-a')
    })

    it('resolves repo root from a subdirectory', async () => {
      const subDir = path.join(repoDir, 'src', 'app')
      fs.mkdirSync(subDir, { recursive: true })
      const branches = await manager.listBranches(subDir)
      expect(branches.length).toBeGreaterThan(0)
    })

    it('rejects for non-git directory', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'))
      await expect(manager.listBranches(tmpDir)).rejects.toThrow()
      fs.rmSync(tmpDir, { recursive: true })
    })
  })

  describe('create', () => {
    it('creates a worktree and branch', async () => {
      const result = await manager.create(repoDir, 'my-workspace', 'master')
      expect(result.branchName).toBe('my-workspace')
      expect(result.relativeProjectPath).toBe('')
      expect(canonicalFilePath(result.worktreePath)).toBe(canonicalFilePath(path.join(repoDir, '.worktrees', 'my-workspace')))
      expect(fs.existsSync(result.worktreePath)).toBe(true)
      // Verify the branch was created
      const branches = await manager.listBranches(repoDir)
      expect(branches).toContain('my-workspace')
    })

    it('places worktree under .worktrees/', async () => {
      const result = await manager.create(repoDir, 'test-ws', 'master')
      expect(canonicalFilePath(result.worktreePath)).toBe(
        canonicalFilePath(path.join(repoDir, '.worktrees', 'test-ws'))
      )
    })

    it('computes relativeProjectPath for subdirectory projects', async () => {
      const subDir = path.join(repoDir, 'apps', 'web')
      fs.mkdirSync(subDir, { recursive: true })
      const result = await manager.create(subDir, 'sub-ws', 'master')
      expect(result.relativeProjectPath).toBe('apps/web')
      expect(canonicalFilePath(result.worktreePath)).toBe(
        canonicalFilePath(path.join(repoDir, '.worktrees', 'sub-ws'))
      )
    })

    it('rejects invalid branch names', async () => {
      await expect(manager.create(repoDir, 'invalid name with spaces', 'master')).rejects.toThrow()
    })

    it('rejects duplicate branch names', async () => {
      await manager.create(repoDir, 'dup-branch', 'master')
      await expect(manager.create(repoDir, 'dup-branch', 'master')).rejects.toThrow()
    })
  })

  describe('delete', () => {
    it('returns ok for clean merged workspace', async () => {
      const result = await manager.create(repoDir, 'clean-ws', 'master')
      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch: 'master'
      })
      expect(status.status).toBe('ok')
      expect(fs.existsSync(result.worktreePath)).toBe(false)
    })

    it('returns uncommitted for dirty worktree', async () => {
      const result = await manager.create(repoDir, 'dirty-ws', 'master')
      fs.writeFileSync(path.join(result.worktreePath, 'dirty.txt'), 'dirty')
      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch: 'master'
      })
      expect(status.status).toBe('uncommitted')
      expect(fs.existsSync(result.worktreePath)).toBe(true)
    })

    it('returns unmerged for branch with commits not in base', async () => {
      const result = await manager.create(repoDir, 'unmerged-ws', 'master')
      fs.writeFileSync(path.join(result.worktreePath, 'new.txt'), 'content')
      execFileSync('git', ['-C', result.worktreePath, 'add', '.'])
      execFileSync('git', ['-C', result.worktreePath, 'commit', '-m', 'new commit'])
      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch: 'master'
      })
      expect(status.status).toBe('unmerged')
      expect(fs.existsSync(result.worktreePath)).toBe(true)
    })

    it('force deletes dirty worktree', async () => {
      const result = await manager.create(repoDir, 'force-ws', 'master')
      fs.writeFileSync(path.join(result.worktreePath, 'dirty.txt'), 'dirty')
      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch: 'master',
        force: true
      })
      expect(status.status).toBe('ok')
      expect(fs.existsSync(result.worktreePath)).toBe(false)
    })

    it('keeps branch when keepBranch is true', async () => {
      const result = await manager.create(repoDir, 'keep-branch-ws', 'master')
      await manager.delete({
        projectDir: repoDir,
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch: 'master',
        force: true,
        keepBranch: true
      })
      const branches = await manager.listBranches(repoDir)
      expect(branches).toContain('keep-branch-ws')
    })
  })

  describe('delete safety checks fail closed', () => {
    /** Commits a file inside the worktree so its branch is genuinely ahead of the base. */
    function commitInWorktree(worktreePath: string, fileName: string): void {
      fs.writeFileSync(path.join(worktreePath, fileName), 'content')
      execFileSync('git', ['-C', worktreePath, 'add', '.'])
      execFileSync('git', ['-C', worktreePath, 'commit', '-m', `add ${fileName}`])
    }

    it('refuses to delete when the base branch was renamed', async () => {
      const result = await manager.create(repoDir, 'renamed-base-ws', 'master')
      commitInWorktree(result.worktreePath, 'only-here.txt')
      execFileSync('git', ['-C', repoDir, 'branch', '-m', 'master', 'main'])

      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch: 'master'
      })

      expect(status.status).toBe('check-failed')
      expect(status.reason).toContain('master')
      expect(fs.existsSync(result.worktreePath)).toBe(true)
      expect(fs.existsSync(path.join(result.worktreePath, 'only-here.txt'))).toBe(true)
      expect(await manager.listBranches(repoDir)).toContain('renamed-base-ws')
    })

    it('refuses to delete when the base branch was deleted', async () => {
      execFileSync('git', ['-C', repoDir, 'branch', 'temp-base'])
      const result = await manager.create(repoDir, 'gone-base-ws', 'temp-base')
      commitInWorktree(result.worktreePath, 'only-here.txt')
      execFileSync('git', ['-C', repoDir, 'branch', '-D', 'temp-base'])

      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch: 'temp-base'
      })

      expect(status.status).toBe('check-failed')
      expect(fs.existsSync(result.worktreePath)).toBe(true)
      expect(await manager.listBranches(repoDir)).toContain('gone-base-ws')
    })

    it('refuses to delete when the uncommitted-changes check fails', async () => {
      // An existing directory that git cannot report status for: not a repository at all.
      const strayDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stray-')))
      fs.writeFileSync(path.join(strayDir, 'keep-me.txt'), 'precious')
      execFileSync('git', ['-C', repoDir, 'branch', 'stray-ws'])

      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: strayDir,
        branchName: 'stray-ws',
        baseBranch: 'master'
      })

      expect(status.status).toBe('check-failed')
      expect(status.reason).toContain('uncommitted')
      expect(fs.existsSync(path.join(strayDir, 'keep-me.txt'))).toBe(true)
      expect(await manager.listBranches(repoDir)).toContain('stray-ws')
      fs.rmSync(strayDir, { recursive: true, force: true })
    })

    // PATH-front POSIX `git` shim: execFile('git') on Windows only launches git.exe,
    // so this timeout path is covered on Linux/macOS (and in CI), not here.
    it.skipIf(process.platform === 'win32')('refuses to delete when a check times out', async () => {
      const result = await manager.create(repoDir, 'timeout-ws', 'master')
      // Shadow `git status` with a command that never answers; everything else passes through.
      const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-shim-'))
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
      fs.writeFileSync(
        path.join(shimDir, 'git'),
        `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "status" ]; then exec sleep 60; fi\ndone\nexec ${realGit} "$@"\n`,
        { mode: 0o755 }
      )
      const originalPath = process.env.PATH
      process.env.PATH = `${shimDir}:${originalPath}`
      try {
        const status = await manager.delete({
          projectDir: repoDir,
          worktreePath: result.worktreePath,
          branchName: result.branchName,
          baseBranch: 'master'
        })
        expect(status.status).toBe('check-failed')
      } finally {
        process.env.PATH = originalPath
        fs.rmSync(shimDir, { recursive: true, force: true })
      }

      expect(fs.existsSync(result.worktreePath)).toBe(true)
      expect(await manager.listBranches(repoDir)).toContain('timeout-ws')
    }, 20000)

    it('still reports uncommitted and unmerged when the checks do complete', async () => {
      const result = await manager.create(repoDir, 'both-ws', 'master')
      commitInWorktree(result.worktreePath, 'committed.txt')
      fs.writeFileSync(path.join(result.worktreePath, 'dirty.txt'), 'dirty')

      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch: 'master'
      })

      expect(status.status).toBe('uncommitted-and-unmerged')
      expect(status.baseBranch).toBe('master')
      expect(fs.existsSync(result.worktreePath)).toBe(true)
    })
  })

  describe('delete validates the worktree before recursive removal', () => {
    it('refuses to recursively delete a path that is not a registered worktree', async () => {
      const strayDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stray-')))
      fs.mkdirSync(path.join(strayDir, 'nested'))
      fs.writeFileSync(path.join(strayDir, 'nested', 'keep-me.txt'), 'precious')
      execFileSync('git', ['-C', repoDir, 'branch', 'stale-record-ws'])

      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: strayDir,
        branchName: 'stale-record-ws',
        baseBranch: 'master',
        force: true
      })

      expect(status.status).toBe('invalid-worktree')
      expect(status.reason).toContain(strayDir)
      expect(fs.existsSync(path.join(strayDir, 'nested', 'keep-me.txt'))).toBe(true)
      // The branch is left alone too: the record it came from is not trustworthy.
      expect(await manager.listBranches(repoDir)).toContain('stale-record-ws')
      fs.rmSync(strayDir, { recursive: true, force: true })
    })

    it('refuses when the stale path sits inside the repo .worktrees directory', async () => {
      const strayDir = path.join(repoDir, '.worktrees', 'reused-name')
      fs.mkdirSync(strayDir, { recursive: true })
      fs.writeFileSync(path.join(strayDir, 'keep-me.txt'), 'precious')

      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: strayDir,
        branchName: 'reused-name',
        baseBranch: 'master',
        force: true
      })

      expect(status.status).toBe('invalid-worktree')
      expect(fs.existsSync(path.join(strayDir, 'keep-me.txt'))).toBe(true)
    })

    it('still falls back to a recursive removal for a genuine worktree', async () => {
      const result = await manager.create(repoDir, 'locked-ws', 'master')
      // A locked worktree makes `git worktree remove --force` fail, exercising the fallback.
      execFileSync('git', ['-C', repoDir, 'worktree', 'lock', result.worktreePath])

      const status = await manager.delete({
        projectDir: repoDir,
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch: 'master',
        force: true
      })

      expect(status.status).toBe('ok')
      expect(fs.existsSync(result.worktreePath)).toBe(false)
      // (The branch survives here only because a locked worktree also blocks `worktree prune`,
      // which is unchanged behaviour; the point of the case is that the directory still goes.)
    })
  })

  describe('restore (reopening an archived stream)', () => {
    it('checks the kept branch out again at the old path, with its commits', async () => {
      const created = await manager.create(repoDir, 'rel-1', 'master')
      fs.writeFileSync(path.join(created.worktreePath, 'work.txt'), 'kept')
      execFileSync('git', ['-C', created.worktreePath, 'add', '.'])
      execFileSync('git', ['-C', created.worktreePath, 'commit', '-m', 'work'])
      await manager.delete({ projectDir: repoDir, ...created, baseBranch: 'master', force: true, keepBranch: true })
      expect(fs.existsSync(created.worktreePath)).toBe(false)

      const restored = await manager.restore(repoDir, created.worktreePath, 'rel-1')

      expect(restored).toEqual({ status: 'ok', worktreePath: created.worktreePath, branchName: 'rel-1', relativeProjectPath: '' })
      expect(fs.readFileSync(path.join(created.worktreePath, 'work.txt'), 'utf8')).toBe('kept')
    })

    it('reuses a worktree that is still there', async () => {
      const created = await manager.create(repoDir, 'still-here', 'master')
      const restored = await manager.restore(repoDir, created.worktreePath, 'still-here')
      expect(restored).toMatchObject({ status: 'ok', worktreePath: created.worktreePath })
    })

    it('reports a discarded branch as branch-missing and creates nothing', async () => {
      const created = await manager.create(repoDir, 'gone', 'master')
      await manager.delete({ projectDir: repoDir, ...created, baseBranch: 'master', force: true })

      const restored = await manager.restore(repoDir, created.worktreePath, 'gone')

      expect(restored).toEqual({ status: 'branch-missing' })
      expect(fs.existsSync(created.worktreePath)).toBe(false)
    })

    it('keeps the project folder inside the repository', async () => {
      const sub = path.join(repoDir, 'apps', 'web')
      fs.mkdirSync(sub, { recursive: true })
      execFileSync('git', ['-C', repoDir, 'branch', 'nested'])
      const restored = await manager.restore(sub, path.join(repoDir, '.worktrees', 'nested'), 'nested')
      expect(restored).toMatchObject({ status: 'ok', relativeProjectPath: 'apps/web' })
    })
  })
})

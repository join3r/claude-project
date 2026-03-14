import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WorkspaceManager } from '../src/main/workspace-manager'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'master', dir])
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'])
}

describe('WorkspaceManager', () => {
  let manager: WorkspaceManager
  let repoDir: string

  beforeEach(() => {
    repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-')))
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
      expect(fs.existsSync(result.worktreePath)).toBe(true)
      // Verify the branch was created
      const branches = await manager.listBranches(repoDir)
      expect(branches).toContain('my-workspace')
    })

    it('places worktree under .worktrees/', async () => {
      const result = await manager.create(repoDir, 'test-ws', 'master')
      expect(result.worktreePath).toBe(path.join(repoDir, '.worktrees', 'test-ws'))
    })

    it('computes relativeProjectPath for subdirectory projects', async () => {
      const subDir = path.join(repoDir, 'apps', 'web')
      fs.mkdirSync(subDir, { recursive: true })
      const result = await manager.create(subDir, 'sub-ws', 'master')
      expect(result.relativeProjectPath).toBe(path.join('apps', 'web'))
      expect(result.worktreePath).toBe(path.join(repoDir, '.worktrees', 'sub-ws'))
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
})

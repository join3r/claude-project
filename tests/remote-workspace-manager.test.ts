import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFile: vi.fn() }
})

import { execFile, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RemoteWorkspaceManager } from '../src/main/remote-workspace-manager'

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

describe('RemoteWorkspaceManager', () => {
  let manager: RemoteWorkspaceManager

  beforeEach(() => {
    manager = new RemoteWorkspaceManager()
    mockExecFile.mockReset()
  })

  it('lists branches through ssh and parses JSON', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      cb(null, JSON.stringify({ ok: true, data: ['main', 'feature-a'] }), '')
      return {} as ReturnType<typeof execFile>
    })

    const branches = await manager.listBranches('/tmp/proj.sock', {
      projectDir: '/srv/app',
      projectId: 'proj-1',
      sshConfig: { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/srv/app' }
    })

    expect(branches).toEqual(['main', 'feature-a'])
    const [cmd, args] = mockExecFile.mock.calls[0]
    expect(cmd).toBe('ssh')
    expect(args).toContain('-S')
    expect(args).toContain('/tmp/proj.sock')
    expect(args).toContain('deploy@dev.example.com')
    expect(args[args.length - 1]).toContain('python3 -c')
  })

  it('creates a workspace through ssh and returns the normalized payload', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      cb(null, JSON.stringify({
        ok: true,
        data: {
          worktreePath: '/srv/app/.worktrees/feature-a',
          branchName: 'feature-a',
          relativeProjectPath: 'apps/web'
        }
      }), '')
      return {} as ReturnType<typeof execFile>
    })

    const result = await manager.create('/tmp/proj.sock', {
      projectDir: '/srv/app/apps/web',
      projectId: 'proj-1',
      sshConfig: { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/srv/app/apps/web' },
      name: 'feature-a',
      baseBranch: 'main'
    })

    expect(result).toEqual({
      worktreePath: '/srv/app/.worktrees/feature-a',
      branchName: 'feature-a',
      relativeProjectPath: 'apps/web'
    })
  })

  it('returns delete preflight status from ssh JSON', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      cb(null, JSON.stringify({ ok: true, data: { status: 'unmerged', baseBranch: 'main' } }), '')
      return {} as ReturnType<typeof execFile>
    })

    const result = await manager.delete('/tmp/proj.sock', {
      projectDir: '/srv/app',
      projectId: 'proj-1',
      sshConfig: { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/srv/app' },
      worktreePath: '/srv/app/.worktrees/feature-a',
      branchName: 'feature-a',
      baseBranch: 'main'
    })

    expect(result).toEqual({ status: 'unmerged', baseBranch: 'main' })
  })

  it('surfaces remote operation errors', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      cb(null, JSON.stringify({ ok: false, error: 'Invalid branch name: "bad name"' }), '')
      return {} as ReturnType<typeof execFile>
    })

    await expect(manager.create('/tmp/proj.sock', {
      projectDir: '/srv/app',
      projectId: 'proj-1',
      sshConfig: { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/srv/app' },
      name: 'bad name',
      baseBranch: 'main'
    })).rejects.toThrow('Invalid branch name')
  })

  it('shell-quotes the embedded remote script payload', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      cb(null, JSON.stringify({ ok: true, data: ['main'] }), '')
      return {} as ReturnType<typeof execFile>
    })

    await manager.listBranches('/tmp/proj.sock', {
      projectDir: "/srv/user's app",
      projectId: 'proj-1',
      sshConfig: { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: "/srv/user's app" }
    })

    const args = mockExecFile.mock.calls[0][1] as string[]
    expect(args[args.length - 1]).toContain("python3 -c '")
    expect(args[args.length - 1]).toContain("base64.b64decode('\\''")
  })
})

const hasPython3 = ((): boolean => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/**
 * The remote side is a python script shipped over ssh, so the only way to test its logic is to
 * run it. These cases intercept the ssh invocation and execute the very command string that
 * would have been handed to the remote shell, against a real local repository.
 */
describe.skipIf(!hasPython3)('RemoteWorkspaceManager remote script', () => {
  let manager: RemoteWorkspaceManager
  let repoDir: string

  const sshConfig = { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/srv/app' }

  function runScriptLocally(): void {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const remoteCommand = args[args.length - 1]
      try {
        const stdout = execFileSync('sh', ['-c', remoteCommand], { encoding: 'utf8' })
        cb(null, stdout, '')
      } catch (err) {
        cb(err as Error, '', '')
      }
      return {} as ReturnType<typeof execFile>
    })
  }

  function createWorktree(name: string, baseBranch: string): string {
    const worktreePath = path.join(repoDir, '.worktrees', name)
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', worktreePath, '-b', name, baseBranch])
    return worktreePath
  }

  function commitInWorktree(worktreePath: string, fileName: string): void {
    fs.writeFileSync(path.join(worktreePath, fileName), 'content')
    execFileSync('git', ['-C', worktreePath, 'add', '.'])
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', `add ${fileName}`])
  }

  function listBranches(): string[] {
    return execFileSync('git', ['-C', repoDir, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
  }

  function deleteWorkspace(request: { worktreePath: string; branchName: string; baseBranch: string; force?: boolean; keepBranch?: boolean }) {
    return manager.delete('/tmp/proj.sock', {
      projectDir: repoDir,
      projectId: 'proj-1',
      sshConfig,
      ...request
    })
  }

  beforeEach(() => {
    manager = new RemoteWorkspaceManager()
    mockExecFile.mockReset()
    runScriptLocally()
    repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ws-test-')))
    execFileSync('git', ['init', '-b', 'master', repoDir])
    execFileSync('git', ['-C', repoDir, 'commit', '--allow-empty', '-m', 'init'])
  })

  afterEach(() => {
    try {
      execFileSync('git', ['-C', repoDir, 'worktree', 'prune'])
    } catch {}
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  it('deletes a clean merged workspace', async () => {
    const worktreePath = createWorktree('clean-ws', 'master')

    const result = await deleteWorkspace({ worktreePath, branchName: 'clean-ws', baseBranch: 'master' })

    expect(result.status).toBe('ok')
    expect(fs.existsSync(worktreePath)).toBe(false)
    expect(listBranches()).not.toContain('clean-ws')
  })

  it('reports uncommitted and unmerged work without deleting', async () => {
    const worktreePath = createWorktree('dirty-ws', 'master')
    commitInWorktree(worktreePath, 'committed.txt')
    fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'dirty')

    const result = await deleteWorkspace({ worktreePath, branchName: 'dirty-ws', baseBranch: 'master' })

    expect(result).toEqual({ status: 'uncommitted-and-unmerged', baseBranch: 'master' })
    expect(fs.existsSync(worktreePath)).toBe(true)
    expect(listBranches()).toContain('dirty-ws')
  })

  it('refuses to delete when the base branch was renamed', async () => {
    const worktreePath = createWorktree('renamed-base-ws', 'master')
    commitInWorktree(worktreePath, 'only-here.txt')
    execFileSync('git', ['-C', repoDir, 'branch', '-m', 'master', 'main'])

    const result = await deleteWorkspace({ worktreePath, branchName: 'renamed-base-ws', baseBranch: 'master' })

    expect(result.status).toBe('check-failed')
    expect(result.reason).toContain('master')
    expect(fs.existsSync(path.join(worktreePath, 'only-here.txt'))).toBe(true)
    expect(listBranches()).toContain('renamed-base-ws')
  })

  it('refuses to delete when the uncommitted-changes check fails', async () => {
    const strayDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-stray-')))
    fs.writeFileSync(path.join(strayDir, 'keep-me.txt'), 'precious')
    execFileSync('git', ['-C', repoDir, 'branch', 'stray-ws'])

    const result = await deleteWorkspace({ worktreePath: strayDir, branchName: 'stray-ws', baseBranch: 'master' })

    expect(result.status).toBe('check-failed')
    expect(result.reason).toContain('uncommitted')
    expect(fs.existsSync(path.join(strayDir, 'keep-me.txt'))).toBe(true)
    expect(listBranches()).toContain('stray-ws')
    fs.rmSync(strayDir, { recursive: true, force: true })
  })

  it('refuses to recursively delete a path that is not a registered worktree', async () => {
    const strayDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-stray-')))
    fs.mkdirSync(path.join(strayDir, 'nested'))
    fs.writeFileSync(path.join(strayDir, 'nested', 'keep-me.txt'), 'precious')
    execFileSync('git', ['-C', repoDir, 'branch', 'stale-record-ws'])

    const result = await deleteWorkspace({
      worktreePath: strayDir,
      branchName: 'stale-record-ws',
      baseBranch: 'master',
      force: true
    })

    expect(result.status).toBe('invalid-worktree')
    expect(result.reason).toContain(strayDir)
    expect(fs.existsSync(path.join(strayDir, 'nested', 'keep-me.txt'))).toBe(true)
    expect(listBranches()).toContain('stale-record-ws')
    fs.rmSync(strayDir, { recursive: true, force: true })
  })

  it('still falls back to a recursive removal for a genuine worktree', async () => {
    const worktreePath = createWorktree('locked-ws', 'master')
    execFileSync('git', ['-C', repoDir, 'worktree', 'lock', worktreePath])

    const result = await deleteWorkspace({ worktreePath, branchName: 'locked-ws', baseBranch: 'master', force: true })

    expect(result.status).toBe('ok')
    expect(fs.existsSync(worktreePath)).toBe(false)
  })
})

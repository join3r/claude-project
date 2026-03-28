import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFile: vi.fn() }
})

import { execFile } from 'child_process'
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

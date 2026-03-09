import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock child_process at module level BEFORE SshConnectionManager is imported.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFile: vi.fn() }
})

import { execFile } from 'child_process'
import { SshConnectionManager } from '../src/main/ssh-connection-manager'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Access the mock through the named import (vi.mock has already replaced it)
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

describe('SshConnectionManager', () => {
  let manager: SshConnectionManager
  let socketDir: string

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-test-'))
    manager = new SshConnectionManager(socketDir, 9999)
  })

  afterEach(() => {
    manager.disconnectAll()
    fs.rmSync(socketDir, { recursive: true })
  })

  it('starts with disconnected state', () => {
    expect(manager.getStatus('proj-1')).toBe('disconnected')
  })

  it('returns socket path for a project', () => {
    const sockPath = manager.getSocketPath('proj-1')
    expect(sockPath).toBe(path.join(socketDir, 'proj-1.sock'))
  })

  it('builds correct ssh args for ControlMaster', () => {
    const args = manager.buildMasterArgs('proj-1', {
      host: 'dev.example.com',
      port: 2222,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    })
    expect(args).toContain('-M')
    expect(args).toContain('-fN')
    expect(args).toContain('-S')
    expect(args).toContain(path.join(socketDir, 'proj-1.sock'))
    expect(args).toContain('-p')
    expect(args).toContain('2222')
    expect(args).toContain('deploy@dev.example.com')
  })

  it('builds ssh args with keyFile when provided', () => {
    const args = manager.buildMasterArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      keyFile: '/home/user/.ssh/id_ed25519',
      remoteDir: '/home/deploy/app'
    })
    expect(args).toContain('-i')
    expect(args).toContain('/home/user/.ssh/id_ed25519')
  })

  it('includes remote port forwarding in buildForwardArgs', () => {
    const args = manager.buildForwardArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    })
    expect(args).toContain('-R')
    expect(args.some(a => a.match(/^0:localhost:9999$/))).toBe(true)
    expect(args).toContain('-O')
    expect(args).toContain('forward')
  })

  it('builds correct spawn-through args for terminal', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, '/bin/zsh')
    expect(args).toContain('-S')
    expect(args).toContain(path.join(socketDir, 'proj-1.sock'))
    expect(args).toContain('-t')
    expect(args).toContain('deploy@dev.example.com')
    const lastArg = args[args.length - 1]
    expect(lastArg).toContain("cd '/home/deploy/app'")
    expect(lastArg).toContain('/bin/zsh')
  })

  it('builds spawn args with env vars for AI tools', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, 'claude', ['--resume', 'sess-123'], { DEVTOOL_TAB_ID: 'tab-1' })
    const lastArg = args[args.length - 1]
    expect(lastArg).toContain("DEVTOOL_TAB_ID='tab-1'")
    expect(lastArg).toContain("claude '--resume' 'sess-123'")
  })

  it('builds spawn args with command prefix', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, 'claude', [], {}, 'mkdir -p /home/deploy/app/.claude && ')
    const lastArg = args[args.length - 1]
    expect(lastArg).toContain('mkdir -p /home/deploy/app/.claude')
    expect(lastArg).toContain("cd '/home/deploy/app'")
    expect(lastArg).toContain('exec')
    expect(lastArg).toContain('claude')
  })

  it('shell-quotes paths with spaces and special chars', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: "/home/deploy/my project's dir"
    }, '/bin/zsh')
    const lastArg = args[args.length - 1]
    expect(lastArg).toContain("cd '/home/deploy/my project'\\''s dir'")
  })

  it('builds check args', () => {
    const args = manager.buildCheckArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    })
    expect(args).toContain('-O')
    expect(args).toContain('check')
    expect(args).toContain('-S')
    expect(args).toContain(path.join(socketDir, 'proj-1.sock'))
  })

  it('builds exit args', () => {
    const args = manager.buildExitArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    })
    expect(args).toContain('-O')
    expect(args).toContain('exit')
    expect(args).toContain('-S')
  })

  it('emits status-changed events', () => {
    const handler = vi.fn()
    manager.on('status-changed', handler)
    manager.setStatus('proj-1', 'connecting')
    expect(handler).toHaveBeenCalledWith('proj-1', 'connecting')
    expect(manager.getStatus('proj-1')).toBe('connecting')
  })

  it('stores and retrieves remote forwarded port', () => {
    manager.setRemotePort('proj-1', 45678)
    expect(manager.getRemotePort('proj-1')).toBe(45678)
  })

  it('cleans up state on clearProject', () => {
    manager.setStatus('proj-1', 'connected')
    manager.setRemotePort('proj-1', 45678)
    manager.clearProject('proj-1')
    expect(manager.getStatus('proj-1')).toBe('disconnected')
    expect(manager.getRemotePort('proj-1')).toBeUndefined()
  })
})

describe('SshConnectionManager connect/disconnect', () => {
  let manager: SshConnectionManager
  let socketDir: string

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-test-'))
    manager = new SshConnectionManager(socketDir, 9999)
    mockExecFile.mockReset()
  })

  afterEach(() => {
    manager.disconnectAll()
    fs.rmSync(socketDir, { recursive: true })
  })

  it('connect uses two-step flow: master then -O forward for port discovery', async () => {
    const statuses: string[] = []
    manager.on('status-changed', (_id: string, status: string) => statuses.push(status))

    let callCount = 0
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        callCount++
        if (callCount === 1) {
          (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '')
        } else {
          (cb as (err: null, stdout: string, stderr: string) => void)(null, 'Allocated port 45678 for remote forward to localhost:9999', '')
        }
        return {} as ReturnType<typeof execFile>
      }
    )

    await manager.connect('proj-1', {
      host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/app'
    })

    expect(callCount).toBe(2)
    expect(statuses).toEqual(['connecting', 'connected'])
    expect(manager.getRemotePort('proj-1')).toBe(45678)
  })

  it('connect parses bare port number from -O forward stdout', async () => {
    let callCount = 0
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        callCount++
        if (callCount === 1) {
          (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '')
        } else {
          (cb as (err: null, stdout: string, stderr: string) => void)(null, '44069\n', '')
        }
        return {} as ReturnType<typeof execFile>
      }
    )

    await manager.connect('proj-1', {
      host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/app'
    })

    expect(manager.getRemotePort('proj-1')).toBe(44069)
  })

  it('connect sets status to disconnected on failure', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(new Error('Connection refused'))
        return {} as ReturnType<typeof execFile>
      }
    )

    await expect(manager.connect('proj-1', {
      host: 'bad.example.com', port: 22, username: 'deploy', remoteDir: '/app'
    })).rejects.toThrow('Connection refused')

    expect(manager.getStatus('proj-1')).toBe('disconnected')
  })

  it('disconnect sends exit command and clears state', async () => {
    manager.setStatus('proj-1', 'connected')
    manager.setRemotePort('proj-1', 45678)

    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null) => void)(null)
        return {} as ReturnType<typeof execFile>
      }
    )

    await manager.disconnect('proj-1', {
      host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/app'
    })

    expect(manager.getStatus('proj-1')).toBe('disconnected')
    expect(manager.getRemotePort('proj-1')).toBeUndefined()
  })

  it('disconnectAll sends ssh -O exit for each stored config', async () => {
    const config1 = { host: 'a.com', port: 22, username: 'u', remoteDir: '/d' }
    const config2 = { host: 'b.com', port: 22, username: 'u', remoteDir: '/d' }

    manager.setStatus('proj-1', 'connected')
    manager.setStatus('proj-2', 'connected')
    ;(manager as any).configs.set('proj-1', config1)
    ;(manager as any).configs.set('proj-2', config2)

    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null) => void)(null)
        return {} as ReturnType<typeof execFile>
      }
    )

    await manager.disconnectAll()
    expect(mockExecFile).toHaveBeenCalledTimes(2)
    expect(manager.getStatus('proj-1')).toBe('disconnected')
    expect(manager.getStatus('proj-2')).toBe('disconnected')
  })
})

describe('SshConnectionManager health checks', () => {
  let manager: SshConnectionManager
  let socketDir: string

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-test-'))
    manager = new SshConnectionManager(socketDir, 9999)
    vi.useFakeTimers()
  })

  afterEach(() => {
    manager.stopHealthChecks()
    manager.disconnectAll()
    fs.rmSync(socketDir, { recursive: true })
    vi.useRealTimers()
  })

  it('startHealthChecks calls checkConnection periodically', async () => {
    const config = { host: 'h', port: 22, username: 'u', remoteDir: '/d' }
    manager.setStatus('proj-1', 'connected')

    const checkSpy = vi.spyOn(manager, 'checkConnection').mockResolvedValue(true)
    manager.startHealthChecks('proj-1', config, 10000)

    await vi.advanceTimersByTimeAsync(10000)
    expect(checkSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10000)
    expect(checkSpy).toHaveBeenCalledTimes(2)

    checkSpy.mockRestore()
  })

  it('sets disconnected when health check fails', async () => {
    const config = { host: 'h', port: 22, username: 'u', remoteDir: '/d' }
    manager.setStatus('proj-1', 'connected')

    const checkSpy = vi.spyOn(manager, 'checkConnection').mockResolvedValue(false)
    const handler = vi.fn()
    manager.on('status-changed', handler)

    manager.startHealthChecks('proj-1', config, 10000)
    await vi.advanceTimersByTimeAsync(10000)

    expect(manager.getStatus('proj-1')).toBe('disconnected')
    checkSpy.mockRestore()
  })

  it('stopHealthChecks stops the timer', async () => {
    const config = { host: 'h', port: 22, username: 'u', remoteDir: '/d' }
    manager.setStatus('proj-1', 'connected')

    const checkSpy = vi.spyOn(manager, 'checkConnection').mockResolvedValue(true)
    manager.startHealthChecks('proj-1', config, 10000)
    manager.stopHealthChecks()

    await vi.advanceTimersByTimeAsync(20000)
    expect(checkSpy).not.toHaveBeenCalled()
    checkSpy.mockRestore()
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock child_process at module level BEFORE SshConnectionManager is imported.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFile: vi.fn() }
})

import { execFile } from 'child_process'
import {
  SshConnectionManager,
  describeTunnelFailure,
  ensureSshDir,
  formatSshConnectError,
  parseMasterPids,
  quoteSpawnArg,
  spawnCdCommand
} from '../src/main/ssh-connection-manager'
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
    expect(args).toContain('StrictHostKeyChecking=accept-new')
    expect(args).not.toContain('UserKnownHostsFile')
    expect(args).not.toContain('IdentitiesOnly=yes')
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
    expect(args).not.toContain('IdentitiesOnly=yes')
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

  it('builds tunnel forward args', () => {
    const args = manager.buildTunnelForwardArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, {
      host: 'localhost',
      sourcePort: 3000,
      destinationPort: 3000
    })
    expect(args).toContain('-O')
    expect(args).toContain('forward')
    expect(args).toContain('-L')
    expect(args).toContain('3000:localhost:3000')
  })

  it('builds tunnel cancel args', () => {
    const args = manager.buildTunnelCancelArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, {
      host: 'localhost',
      sourcePort: 3000,
      destinationPort: 3000
    })
    expect(args).toContain('-O')
    expect(args).toContain('cancel')
    expect(args).toContain('-L')
    expect(args).toContain('3000:localhost:3000')
  })

  it('builds correct spawn-through args for terminal', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, '/bin/zsh')
    expect(args).toContain('-t')
    expect(args).toContain('deploy@dev.example.com')
    const lastArg = args[args.length - 1]
    expect(lastArg).toMatch(/^bash -l -i -c /)
    expect(lastArg).toContain('/home/deploy/app')
    expect(lastArg).toContain('/bin/zsh')
    if (process.platform === 'win32') {
      expect(args).not.toContain('-S')
    } else {
      expect(args).toContain('-S')
      expect(args).toContain(path.join(socketDir, 'proj-1.sock'))
    }
  })

  it('builds spawn args with env vars for AI tools', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, 'claude', ['--resume', 'sess-123'], { DEVTOOL_TAB_ID: 'tab-1' })
    const lastArg = args[args.length - 1]
    expect(lastArg).toMatch(/^bash -l -i -c /)
    expect(lastArg).toContain('DEVTOOL_TAB_ID=')
    expect(lastArg).toContain('tab-1')
    expect(lastArg).toContain('exec claude')
    expect(lastArg).toContain('--resume')
    expect(lastArg).toContain('sess-123')
  })

  it('double-quotes $HOME paths so bash can expand the pi extension', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, 'pi', ['-e', '$HOME/.devtool-remote/pi-status-extension.mjs'])
    const lastArg = args[args.length - 1]
    expect(lastArg).toContain('"$HOME/.devtool-remote/pi-status-extension.mjs"')
    expect(lastArg).not.toContain("'$HOME/.devtool-remote/pi-status-extension.mjs'")
  })

  it('builds spawn args with command prefix', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, 'claude', [], {}, 'mkdir -p /home/deploy/app/.claude && ')
    const lastArg = args[args.length - 1]
    expect(lastArg).toMatch(/^bash -l -i -c /)
    expect(lastArg).toContain('mkdir -p /home/deploy/app/.claude')
    expect(lastArg).toContain('/home/deploy/app')
    expect(lastArg).toContain('exec')
    expect(lastArg).toContain('claude')
  })

  it('uses cwd override when provided', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, '/bin/zsh', undefined, undefined, undefined, '/home/deploy/app/.worktrees/feature-a')
    const lastArg = args[args.length - 1]
    expect(lastArg).toContain('/home/deploy/app/.worktrees/feature-a')
    expect(lastArg).not.toContain("cd '/home/deploy/app' &&")
  })

  it('shell-quotes paths with spaces and special chars', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: "/home/deploy/my project's dir"
    }, '/bin/zsh')
    const lastArg = args[args.length - 1]
    expect(lastArg).toMatch(/^bash -l -i -c /)
    expect(lastArg).toContain("my project")
    expect(lastArg).toContain("s dir")
  })

  it('shell-quotes cwd overrides with spaces and special chars', () => {
    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, '/bin/zsh', undefined, undefined, undefined, "/home/deploy/my project's dir/.worktrees/ws one")
    const lastArg = args[args.length - 1]
    expect(lastArg).toContain("my project")
    expect(lastArg).toContain('ws one')
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

  it('builds end-to-end probe args as a mux slave running true', () => {
    const args = manager.buildProbeArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    })
    expect(args).toContain('-S')
    expect(args).toContain(path.join(socketDir, 'proj-1.sock'))
    expect(args).toContain('ControlMaster=no')
    expect(args).toContain('BatchMode=yes')
    expect(args[args.length - 1]).toBe('true')
  })



  it('uses bare cd when remote directory is blank', () => {
    expect(spawnCdCommand('')).toBe('cd')
    expect(spawnCdCommand('  ')).toBe('cd')
    expect(spawnCdCommand('/home/deploy')).toBe("cd '/home/deploy'")

    const args = manager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: ''
    }, '/bin/zsh')
    const lastArg = args[args.length - 1]
    expect(lastArg).toContain('cd &&')
    expect(lastArg).not.toContain("cd ''")
  })

  it('does not mux PTY tabs through ControlMaster on Windows', () => {
    const winManager = new SshConnectionManager(socketDir, 9999, { platform: 'win32' })
    const args = winManager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, '/bin/zsh')
    expect(args).not.toContain('-S')
    expect(args).not.toContain(path.join(socketDir, 'proj-1.sock'))
    expect(args).toContain('-t')
    expect(args).toContain('deploy@dev.example.com')
  })

  it('muxes PTY tabs through ControlMaster on non-Windows', () => {
    const unixManager = new SshConnectionManager(socketDir, 9999, { platform: 'linux' })
    const args = unixManager.buildSpawnArgs('proj-1', {
      host: 'dev.example.com',
      port: 22,
      username: 'deploy',
      remoteDir: '/home/deploy/app'
    }, '/bin/zsh')
    expect(args).toContain('-S')
    expect(args).toContain(path.join(socketDir, 'proj-1.sock'))
  })

  it('builds SOCKS proxy args as standalone connection (no ControlMaster socket)', () => {
    const args = manager.buildSocksProxyArgs('proj-1', {
      host: 'dev.example.com',
      port: 2222,
      username: 'deploy',
      keyFile: '/home/user/.ssh/id_ed25519',
      remoteDir: '/home/deploy/app'
    }, 12345)
    // Must NOT use ControlMaster socket — slave exits immediately with -D
    expect(args).not.toContain('-S')
    expect(args).not.toContain(path.join(socketDir, 'proj-1.sock'))
    expect(args).toContain('-p')
    expect(args).toContain('2222')
    expect(args).toContain('-i')
    expect(args).toContain('/home/user/.ssh/id_ed25519')
    expect(args).toContain('-D')
    expect(args).toContain('12345')
    expect(args).toContain('-N')
    expect(args).toContain('ExitOnForwardFailure=yes')
    expect(args).toContain('deploy@dev.example.com')
    expect(args).not.toContain('UserKnownHostsFile')
    expect(args).not.toContain('IdentitiesOnly=yes')
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

    const sshCalls: string[][] = []
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: unknown) => {
        // Windows resolves an absolute ...\Git\usr\bin\ssh.exe, not bare `ssh`.
        if (/(^|[\\/])ssh(\.exe)?$/i.test(cmd)) sshCalls.push(args)
        const stdout = args.includes('-R') ? 'Allocated port 45678 for remote forward to localhost:9999' : ''
        ;(cb as (err: null, stdout: string, stderr: string) => void)(null, stdout, '')
        return {} as ReturnType<typeof execFile>
      }
    )

    await manager.connect('proj-1', {
      host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/app'
    })

    expect(sshCalls).toHaveLength(2)
    expect(sshCalls[0]).toContain('-M')
    expect(sshCalls[1]).toContain('-R')
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

  it('connect names the DevTool known_hosts file on host-key mismatch', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        const err = new Error('Host key verification failed.')
        ;(cb as (err: Error, stdout: string, stderr: string) => void)(
          err,
          '',
          'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'
        )
        return {} as ReturnType<typeof execFile>
      }
    )

    await expect(manager.connect('proj-1', {
      host: 'bad.example.com', port: 22, username: 'deploy', remoteDir: '/app'
    })).rejects.toThrow(/SSH host key mismatch.*known_hosts/)
  })

  it('connect creates the ssh dir as 0700', async () => {
    const dir = path.join(os.tmpdir(), `devtool-ssh-mode-${Date.now()}`)
    const modeManager = new SshConnectionManager(dir, 9999)
    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(new Error('Connection refused'))
        return {} as ReturnType<typeof execFile>
      }
    )
    try {
      await modeManager.connect('proj-1', {
        host: 'bad.example.com', port: 22, username: 'deploy', remoteDir: '/app'
      }).catch(() => {})
      expect(fs.existsSync(dir)).toBe(true)
      if (process.platform !== 'win32') {
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
      }
    } finally {
      modeManager.disconnectAll()
      fs.rmSync(dir, { recursive: true, force: true })
    }
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
    expect(manager.getTunnelState('proj-1')).toEqual({ status: 'inactive' })
  })

  it('setTunnel replaces an existing local forward', async () => {
    const config = { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/app' }
    manager.setStatus('proj-1', 'connected')

    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        ;(cb as (err: null, stdout?: string, stderr?: string) => void)(null, '', '')
        return {} as ReturnType<typeof execFile>
      }
    )

    await manager.setTunnel('proj-1', config, {
      host: 'localhost',
      sourcePort: 3000,
      destinationPort: 3000
    })
    expect(manager.getTunnel('proj-1')).toEqual({
      host: 'localhost',
      sourcePort: 3000,
      destinationPort: 3000
    })
    expect(manager.getTunnelState('proj-1')).toEqual({ status: 'active' })
    expect(mockExecFile).toHaveBeenCalledTimes(1)

    await manager.setTunnel('proj-1', config, {
      host: 'localhost',
      sourcePort: 4000,
      destinationPort: 8080
    })

    expect(mockExecFile).toHaveBeenCalledTimes(3)
    expect(mockExecFile.mock.calls[1][1]).toContain('cancel')
    expect(mockExecFile.mock.calls[1][1]).toContain('3000:localhost:3000')
    expect(mockExecFile.mock.calls[2][1]).toContain('forward')
    expect(mockExecFile.mock.calls[2][1]).toContain('4000:localhost:8080')
    expect(manager.getTunnel('proj-1')).toEqual({
      host: 'localhost',
      sourcePort: 4000,
      destinationPort: 8080
    })
  })

  it('setTunnel clears the existing forward when null is passed', async () => {
    const config = { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/app' }
    manager.setStatus('proj-1', 'connected')

    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        ;(cb as (err: null, stdout?: string, stderr?: string) => void)(null, '', '')
        return {} as ReturnType<typeof execFile>
      }
    )

    await manager.setTunnel('proj-1', config, {
      host: 'localhost',
      sourcePort: 3000,
      destinationPort: 3000
    })
    await manager.setTunnel('proj-1', config, null)

    expect(mockExecFile).toHaveBeenCalledTimes(2)
    expect(mockExecFile.mock.calls[1][1]).toContain('cancel')
    expect(manager.getTunnel('proj-1')).toBeUndefined()
    expect(manager.getTunnelState('proj-1')).toEqual({ status: 'inactive' })
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

describe('SshConnectionManager triggerReconnect', () => {
  let manager: SshConnectionManager
  let socketDir: string
  const config = { host: 'h', port: 22, username: 'u', remoteDir: '/d' }

  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-test-'))
    manager = new SshConnectionManager(socketDir, 9999)
    mockExecFile.mockReset()
  })

  afterEach(() => {
    fs.rmSync(socketDir, { recursive: true })
  })

  it('keeps the connection when the probe succeeds (normal slave exit)', async () => {
    manager.setStatus('proj-1', 'connected')
    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '')
        return {} as ReturnType<typeof execFile>
      }
    )

    manager.triggerReconnect('proj-1', config)
    await flush()

    expect(manager.getStatus('proj-1')).toBe('connected')
  })

  it('tears down and marks disconnected when the probe fails', async () => {
    manager.setStatus('proj-1', 'connected')
    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error) => void)(new Error('Control socket connect: refused'))
        return {} as ReturnType<typeof execFile>
      }
    )

    manager.triggerReconnect('proj-1', config)
    await flush()

    expect(manager.getStatus('proj-1')).toBe('disconnected')
  })

  it('dedupes concurrent probes for the same project', async () => {
    manager.setStatus('proj-1', 'connected')
    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        setTimeout(() => (cb as (err: null, stdout: string, stderr: string) => void)(null, '', ''), 0)
        return {} as ReturnType<typeof execFile>
      }
    )

    manager.triggerReconnect('proj-1', config)
    manager.triggerReconnect('proj-1', config)
    await flush()
    await flush()

    expect(mockExecFile).toHaveBeenCalledTimes(1)
  })

  it('does nothing when not connected', async () => {
    manager.triggerReconnect('proj-1', config)
    await flush()
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('SshConnectionManager verifyConnection', () => {
  let manager: SshConnectionManager
  let socketDir: string
  const config = { host: 'h', port: 22, username: 'u', remoteDir: '/d' }

  const respond = (err: Error | null): void => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        if (err) (cb as (e: Error) => void)(err)
        else (cb as (e: null, stdout: string, stderr: string) => void)(null, '', '')
        return {} as ReturnType<typeof execFile>
      }
    )
  }

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-test-'))
    manager = new SshConnectionManager(socketDir, 9999)
    mockExecFile.mockReset()
  })

  afterEach(() => {
    manager.clearProject('proj-1')
    fs.rmSync(socketDir, { recursive: true })
  })

  it('resolves true and stays connected when the probe reaches the host', async () => {
    manager.setStatus('proj-1', 'connected')
    respond(null)

    await expect(manager.verifyConnection('proj-1', config)).resolves.toBe(true)
    expect(manager.getStatus('proj-1')).toBe('connected')
    const args = mockExecFile.mock.calls[0][1] as string[]
    expect(args).toContain('true')
    expect(args).not.toContain('check')
  })

  it('resolves false and marks disconnected when a stale master fails the probe', async () => {
    manager.setStatus('proj-1', 'connected')
    respond(new Error('mux_client_request_session: read from master failed'))

    await expect(manager.verifyConnection('proj-1', config)).resolves.toBe(false)
    expect(manager.getStatus('proj-1')).toBe('disconnected')
  })

  it('shares one probe between concurrent callers', async () => {
    manager.setStatus('proj-1', 'connected')
    respond(null)

    const [a, b] = await Promise.all([
      manager.verifyConnection('proj-1', config),
      manager.verifyConnection('proj-1', config)
    ])
    expect(a && b).toBe(true)
    expect(mockExecFile).toHaveBeenCalledTimes(1)
  })

  it('resolves false without probing when not connected', async () => {
    await expect(manager.verifyConnection('proj-1', config)).resolves.toBe(false)
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('SshConnectionManager auto-reconnect backoff', () => {
  let manager: SshConnectionManager
  let socketDir: string
  const config = { host: 'h', port: 22, username: 'u', remoteDir: '/d' }

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-test-'))
    manager = new SshConnectionManager(socketDir, 9999)
    mockExecFile.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    manager.clearProject('proj-1')
    manager.stopHealthChecks()
    vi.useRealTimers()
    fs.rmSync(socketDir, { recursive: true })
  })

  it('doubles the delay between failed attempts instead of retrying every second', async () => {
    let up = true
    const masterAttempts: number[] = []
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: unknown) => {
        if (args.includes('-M')) masterAttempts.push(Date.now())
        if (args.includes('-M') && !up) (cb as (e: Error) => void)(new Error('Could not resolve hostname h'))
        else if (args.includes('-R')) (cb as (e: null, o: string, r: string) => void)(null, 'Allocated port 40000\n', '')
        else if (args.includes('check') && !up) (cb as (e: Error) => void)(new Error('no master'))
        else (cb as (e: null, o: string, r: string) => void)(null, '', '')
        return {} as ReturnType<typeof execFile>
      }
    )

    await manager.connect('proj-1', config)
    manager.startHealthChecks('proj-1', config, 10000)
    up = false
    await vi.advanceTimersByTimeAsync(10000) // health check fails → first retry in 1s
    masterAttempts.length = 0
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000)

    const gaps = masterAttempts.slice(1).map((t, i) => t - masterAttempts[i])
    expect(masterAttempts).toHaveLength(4)
    expect(gaps).toEqual([2000, 4000, 8000])
  })
})

describe('SshConnectionManager auto-reconnect restores the configured tunnel', () => {
  let manager: SshConnectionManager
  let socketDir: string
  const config = { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/app' }
  const tunnel = { host: 'localhost', sourcePort: 3000, destinationPort: 3000 }

  /** Drive the mocked ssh binary from its argv: `handler` returns an Error to
   *  fail the call, or a stdout string to succeed it. */
  const respondByArgs = (handler: (args: string[]) => Error | string): void => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: unknown) => {
        const result = handler(args)
        if (result instanceof Error) (cb as (err: Error) => void)(result)
        else (cb as (err: null, stdout: string, stderr: string) => void)(null, result, '')
        return {} as ReturnType<typeof execFile>
      }
    )
  }

  const isTunnelForward = (args: string[]): boolean =>
    args.includes('-L') && args.includes('forward')
  const isMaster = (args: string[]): boolean => args.includes('-M')
  const isRemoteForward = (args: string[]): boolean => args.includes('-R')
  const isCheck = (args: string[]): boolean => args.includes('check')

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-test-'))
    manager = new SshConnectionManager(socketDir, 9999)
    mockExecFile.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    manager.clearProject('proj-1')
    manager.stopHealthChecks()
    vi.useRealTimers()
    fs.rmSync(socketDir, { recursive: true })
  })

  it('recreates the tunnel on auto-reconnect and only then reports connected', async () => {
    const events: string[] = []
    manager.on('status-changed', (_id: string, status: string) => events.push(`ssh:${status}`))
    manager.on('tunnel-status-changed', (_id: string, status: string) => events.push(`tunnel:${status}`))

    respondByArgs(args => (isRemoteForward(args) ? 'Allocated port 45678' : ''))

    await manager.connect('proj-1', config, { tunnel })
    expect(manager.getStatus('proj-1')).toBe('connected')
    expect(manager.getTunnelState('proj-1')).toEqual({ status: 'active' })

    // Health check fails -> teardown -> auto-reconnect (first backoff is 1s).
    const checkSpy = vi.spyOn(manager, 'checkConnection').mockResolvedValue(false)
    manager.startHealthChecks('proj-1', config, 10000)
    await vi.advanceTimersByTimeAsync(10000)
    expect(manager.getStatus('proj-1')).toBe('disconnected')

    checkSpy.mockRestore()
    mockExecFile.mockClear()
    respondByArgs(args => (isRemoteForward(args) ? 'Allocated port 45678' : ''))

    await vi.advanceTimersByTimeAsync(1000)

    expect(manager.getStatus('proj-1')).toBe('connected')
    expect(manager.getTunnel('proj-1')).toEqual(tunnel)
    expect(manager.getTunnelState('proj-1')).toEqual({ status: 'active' })

    // The reconnect re-issued the same forward the user configured.
    const forwardCalls = mockExecFile.mock.calls.filter(call => isTunnelForward(call[1] as string[]))
    expect(forwardCalls).toHaveLength(1)
    expect(forwardCalls[0][1]).toContain('3000:localhost:3000')

    // 'connected' is never announced while the tunnel is down: every ssh:connected
    // is immediately preceded by the tunnel going active.
    for (const [i, event] of events.entries()) {
      if (event === 'ssh:connected') expect(events[i - 1]).toBe('tunnel:active')
    }
    expect(events.filter(e => e === 'ssh:connected')).toHaveLength(2)
  })

  it('reports a degraded state, not connected, when the tunnel fails after reconnect', async () => {
    respondByArgs(args => (isRemoteForward(args) ? 'Allocated port 45678' : ''))
    await manager.connect('proj-1', config, { tunnel })

    const checkSpy = vi.spyOn(manager, 'checkConnection').mockResolvedValue(false)
    manager.startHealthChecks('proj-1', config, 10000)
    await vi.advanceTimersByTimeAsync(10000)
    checkSpy.mockRestore()

    // Master comes back, but the local port is taken and the forward fails.
    respondByArgs(args => {
      if (isTunnelForward(args)) return new Error('bind: Address already in use')
      if (isRemoteForward(args)) return 'Allocated port 45678'
      return ''
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(manager.getStatus('proj-1')).not.toBe('connected')
    expect(manager.getStatus('proj-1')).toBe('connecting')
    expect(manager.getTunnelState('proj-1')).toEqual({
      status: 'error',
      error: expect.stringContaining('Could not open local port 3000')
    })
    expect(manager.getTunnel('proj-1')).toBeUndefined()

    // Retries on the same backoff cadence and reports connected once it recovers.
    respondByArgs(args => {
      if (isCheck(args)) return ''
      if (isRemoteForward(args)) return 'Allocated port 45678'
      return ''
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(manager.getStatus('proj-1')).toBe('connected')
    expect(manager.getTunnelState('proj-1')).toEqual({ status: 'active' })
    expect(manager.getTunnel('proj-1')).toEqual(tunnel)
  })

  it('reconnects a project without a tunnel exactly as before', async () => {
    respondByArgs(args => (isRemoteForward(args) ? 'Allocated port 45678' : ''))

    await manager.connect('proj-1', config)
    expect(manager.getStatus('proj-1')).toBe('connected')

    const checkSpy = vi.spyOn(manager, 'checkConnection').mockResolvedValue(false)
    manager.startHealthChecks('proj-1', config, 10000)
    await vi.advanceTimersByTimeAsync(10000)
    checkSpy.mockRestore()

    mockExecFile.mockClear()
    respondByArgs(args => (isRemoteForward(args) ? 'Allocated port 45678' : ''))
    await vi.advanceTimersByTimeAsync(1000)

    expect(manager.getStatus('proj-1')).toBe('connected')
    expect(manager.getTunnel('proj-1')).toBeUndefined()
    expect(manager.getTunnelState('proj-1')).toEqual({ status: 'inactive' })
    expect(mockExecFile.mock.calls.filter(call => isTunnelForward(call[1] as string[]))).toHaveLength(0)
    // Only the master and the remote hook forward, no spurious extra ssh calls.
    expect(mockExecFile.mock.calls.filter(call => isMaster(call[1] as string[]))).toHaveLength(1)
    expect(mockExecFile.mock.calls.filter(call => isRemoteForward(call[1] as string[]))).toHaveLength(1)
  })
})

describe('SshConnectionManager SOCKS proxy', () => {
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

  it('getSocksProxy returns undefined when no proxy exists', () => {
    expect(manager.getSocksProxy('proj-1')).toBeUndefined()
  })

  it('getConfig returns stored config', () => {
    ;(manager as any).configs.set('proj-1', { host: 'h', port: 22, username: 'u', remoteDir: '/d' })
    expect(manager.getConfig('proj-1')).toEqual({ host: 'h', port: 22, username: 'u', remoteDir: '/d' })
  })

  it('clearProject removes SOCKS proxy entry', () => {
    ;(manager as any).socksProxies.set('proj-1', { port: 12345, process: { kill: vi.fn() } })
    manager.clearProject('proj-1')
    expect(manager.getSocksProxy('proj-1')).toBeUndefined()
  })

  it('startSocksProxy returns existing port when proxy already running (idempotent)', async () => {
    ;(manager as any).socksProxies.set('proj-1', { port: 54321, process: { kill: vi.fn() } })
    manager.setStatus('proj-1', 'connected')

    const port = await manager.startSocksProxy('proj-1', {
      host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/app'
    })
    expect(port).toBe(54321)
  })

  it('startSocksProxy throws when SSH is not connected', async () => {
    await expect(manager.startSocksProxy('proj-1', {
      host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/app'
    })).rejects.toThrow('SSH connection not established')
  })

  it('stopSocksProxy is a no-op when no proxy exists', async () => {
    await manager.stopSocksProxy('proj-1')
    expect(manager.getSocksProxy('proj-1')).toBeUndefined()
  })
})

describe('ssh trust helpers', () => {
  it('ensureSshDir creates the directory as 0700', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-ensure-'))
    fs.rmSync(dir, { recursive: true })
    ensureSshDir(dir)
    expect(fs.existsSync(dir)).toBe(true)
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    }
    fs.rmSync(dir, { recursive: true })
  })

  it('ensureSshDir chmods an existing directory to 0700', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-ensure-'))
    fs.chmodSync(dir, 0o755)
    ensureSshDir(dir)
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    }
    fs.rmSync(dir, { recursive: true })
  })

  it('formatSshConnectError names known_hosts on mismatch', () => {
    const err = Object.assign(new Error('Host key verification failed.'), {
      stderr: 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'
    })
    const formatted = formatSshConnectError(err)
    expect(formatted.message).toContain('SSH host key mismatch')
    expect(formatted.message).toContain('~/.ssh/known_hosts')
  })

  it('formatSshConnectError leaves unrelated errors alone', () => {
    const err = new Error('Connection refused')
    expect(formatSshConnectError(err)).toBe(err)
  })

  it('formatSshConnectError explains Windows OpenSSH ControlMaster failure', () => {
    const err = Object.assign(new Error('Command failed: ssh -M'), {
      stderr: 'getsockname failed: Not a socket\r\n'
    })
    const formatted = formatSshConnectError(err)
    expect(formatted.message).toMatch(/Git for Windows/)
    expect(formatted.message).not.toMatch(/getsockname/)
  })


  it('quoteSpawnArg double-quotes only the Pi extension path and single-quotes everything else', () => {
    expect(quoteSpawnArg('$HOME/.devtool-remote/pi-status-extension.mjs')).toBe(
      '"$HOME/.devtool-remote/pi-status-extension.mjs"'
    )
    // A user-supplied $HOME/... arg must not let the remote shell expand `$(...)`.
    expect(quoteSpawnArg('$HOME/x$(id)')).toBe("'$HOME/x$(id)'")
    expect(quoteSpawnArg('--resume')).toBe("'--resume'")
  })
})

describe('describeTunnelFailure', () => {
  const tunnel = { host: 'localhost', sourcePort: 54553, destinationPort: 54553 }

  it('explains a mux forward rejection as a busy local port', () => {
    const err = new Error(
      'Command failed: ssh -S /tmp/p.sock -O forward -L 54553:localhost:54553 u@h\n' +
      'mux_client_forward: forwarding request failed: Port forwarding failed'
    )
    expect(describeTunnelFailure(err, tunnel)).toContain('Could not open local port 54553')
  })

  it('explains a bind failure reported only on stderr', () => {
    const err = Object.assign(new Error('Command failed: ssh ...'), {
      stderr: 'bind [127.0.0.1]:54553: Address already in use'
    })
    expect(describeTunnelFailure(err, tunnel)).toContain('Could not open local port 54553')
  })

  it('passes unrelated failures through untouched', () => {
    expect(describeTunnelFailure(new Error('Connection refused'), tunnel)).toBe('Connection refused')
  })
})

describe('parseMasterPids', () => {
  const sock = '/Users/j/.devtool/ssh/934a7a54.sock'
  const master = (pid: number, s = sock): string =>
    `${pid} ssh -fN -M -S ${s} -o StrictHostKeyChecking=accept-new -p 22 deploy@dev.example.com`

  it('finds a master whose socket file is already unlinked', () => {
    expect(parseMasterPids(master(48865), sock)).toEqual([48865])
  })

  it('finds every stray master for the socket', () => {
    expect(parseMasterPids([master(48865), master(86434), master(79958)].join('\n'), sock)).toEqual([48865, 86434, 79958])
  })

  it('ignores mux slaves — those are the user\'s open remote terminals', () => {
    const slave = `10245 ssh -S ${sock} -o ControlMaster=no -t deploy@dev.example.com bash -l -i -c 'cd /app'`
    expect(parseMasterPids(slave, sock)).toEqual([])
  })

  it('ignores masters belonging to another config dir (dev vs packaged)', () => {
    const devSock = '/Users/j/.devtool-dev/ssh/934a7a54.sock'
    expect(parseMasterPids(master(48865, devSock), sock)).toEqual([])
  })

  it('ignores masters for a different project on the same host', () => {
    expect(parseMasterPids(master(30169, '/Users/j/.devtool/ssh/8daa84c6.sock'), sock)).toEqual([])
  })

  it('does not match a socket path that merely shares a prefix', () => {
    expect(parseMasterPids(master(1, sock + '.k3oVLfLK'), sock)).toEqual([])
  })

  it('tolerates ps noise and blank lines', () => {
    expect(parseMasterPids(`\n  PID COMMAND\n${master(48865)}\n\n`, sock)).toEqual([48865])
  })
})

describe('SshConnectionManager orphaned ControlMaster cleanup', () => {
  let manager: SshConnectionManager
  let socketDir: string
  const config = { host: 'dev.example.com', port: 22, username: 'deploy', remoteDir: '/app' }

  const isExit = (args: string[]): boolean => args.includes('exit')
  const isCheck = (args: string[]): boolean => args.includes('check')

  /** Signal 0 is a liveness probe — throwing ESRCH says "the process is gone",
   *  which is what lets `terminate()` stop waiting. */
  const spyOnKill = (): ReturnType<typeof vi.spyOn> =>
    vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      return true
    }) as ReturnType<typeof vi.spyOn>

  const respondByArgs = (handler: (args: string[]) => Error | string): void => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: unknown) => {
        const result = handler(args)
        if (result instanceof Error) (cb as (err: Error) => void)(result)
        else (cb as (err: null, stdout: string, stderr: string) => void)(null, result, '')
        return {} as ReturnType<typeof execFile>
      }
    )
  }

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-ssh-test-'))
    manager = new SshConnectionManager(socketDir, 9999)
    mockExecFile.mockReset()
    // A leftover socket from a previous run, so connect() takes the cleanup path.
    fs.writeFileSync(manager.getSocketPath('proj-1'), '')
  })

  afterEach(() => {
    manager.clearProject('proj-1')
    fs.rmSync(socketDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('kills the master by pid when `-O exit` fails, so it cannot orphan the tunnel port', async () => {
    const kill = spyOnKill()
    respondByArgs(args => {
      if (isExit(args)) return new Error('Command failed: ssh -O exit')
      if (isCheck(args)) return 'Master running (pid=48865)'
      if (args.includes('-R')) return 'Allocated port 45678'
      return ''
    })

    await manager.connect('proj-1', config)

    expect(kill).toHaveBeenCalledWith(48865, 'SIGTERM')
    expect(manager.getStatus('proj-1')).toBe('connected')
  })

  it('reads the pid from stderr when `-O check` itself exits non-zero', async () => {
    const kill = spyOnKill()
    respondByArgs(args => {
      if (isExit(args)) return new Error('Command failed: ssh -O exit')
      if (isCheck(args)) return Object.assign(new Error('Command failed'), { stderr: 'Master running (pid=1234)\n' })
      if (args.includes('-R')) return 'Allocated port 45678'
      return ''
    })

    await manager.connect('proj-1', config)
    expect(kill).toHaveBeenCalledWith(1234, 'SIGTERM')
  })

  it('kills a master that survived a `-O exit` that reported success', async () => {
    const kill = spyOnKill()
    respondByArgs(args => {
      if (isCheck(args)) return 'Master running (pid=79958)'
      if (args.includes('-R')) return 'Allocated port 45678'
      return ''
    })

    await manager.connect('proj-1', config)
    expect(kill).toHaveBeenCalledWith(79958, 'SIGTERM')
  })

  it('kills nothing when the socket is stale and no master answers', async () => {
    const kill = spyOnKill()
    respondByArgs(args => {
      if (isCheck(args)) return new Error('Control socket connect: No such file or directory')
      if (args.includes('-R')) return 'Allocated port 45678'
      return ''
    })

    await manager.connect('proj-1', config)
    expect(kill).not.toHaveBeenCalled()
    expect(manager.getStatus('proj-1')).toBe('connected')
  })

  it('does not probe for a master when there is no leftover socket', async () => {
    fs.unlinkSync(manager.getSocketPath('proj-1'))
    const kill = spyOnKill()
    respondByArgs(args => (args.includes('-R') ? 'Allocated port 45678' : ''))

    await manager.connect('proj-1', config)

    expect(mockExecFile.mock.calls.filter(call => isCheck(call[1] as string[]))).toHaveLength(0)
    expect(kill).not.toHaveBeenCalled()
  })

  it('leaves no pid to kill when no master answers the socket', async () => {
    const kill = spyOnKill()
    respondByArgs(args => {
      if (isExit(args) || isCheck(args)) return new Error('Command failed: no controlling master')
      if (args.includes('-R')) return 'Allocated port 45678'
      return ''
    })

    await manager.connect('proj-1', config)
    expect(kill).not.toHaveBeenCalled()
  })

  // The failure this whole path exists for: a master left over from an earlier
  // run whose socket was unlinked out from under it. Nothing socket-based can
  // reach it, and it squats the tunnel port until it is killed by pid.
  it('reaps a stray master even when no socket file is left to reach it', async () => {
    fs.unlinkSync(manager.getSocketPath('proj-1'))
    const kill = spyOnKill()
    const sock = manager.getSocketPath('proj-1')
    respondByArgs(args => {
      if (args.includes('-axo')) return `48865 ssh -fN -M -S ${sock} -p 22 deploy@dev.example.com`
      if (args.includes('-R')) return 'Allocated port 45678'
      return ''
    })

    await manager.connect('proj-1', config)

    expect(kill).toHaveBeenCalledWith(48865, 'SIGTERM')
    expect(manager.getStatus('proj-1')).toBe('connected')
  })

  it('kills the stray before spawning its replacement, so the port is free', async () => {
    fs.unlinkSync(manager.getSocketPath('proj-1'))
    const order: string[] = []
    vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      order.push('kill')
      return true
    })
    const sock = manager.getSocketPath('proj-1')
    respondByArgs(args => {
      if (args.includes('-axo')) return `48865 ssh -fN -M -S ${sock} -p 22 deploy@dev.example.com`
      if (args.includes('-M')) order.push('spawn-master')
      if (args.includes('-R')) return 'Allocated port 45678'
      return ''
    })

    await manager.connect('proj-1', config)

    expect(order).toEqual(['kill', 'spawn-master'])
  })

  it('still connects when the process list is unavailable', async () => {
    fs.unlinkSync(manager.getSocketPath('proj-1'))
    const kill = spyOnKill()
    respondByArgs(args => {
      if (args.includes('-axo')) return new Error('ps: command not found')
      if (args.includes('-R')) return 'Allocated port 45678'
      return ''
    })

    await manager.connect('proj-1', config)

    expect(kill).not.toHaveBeenCalled()
    expect(manager.getStatus('proj-1')).toBe('connected')
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SshConnectionManager } from '../src/main/ssh-connection-manager'
import fs from 'fs'
import path from 'path'
import os from 'os'

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
    // Last arg should be the remote command with shell-quoted dir
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

import { describe, it, expect } from 'vitest'
import { buildReadRemoteFileArgs } from '../src/main/ssh-connection-manager'

const SOCKET_DIR = '/tmp/devtool-sockets'

const SSH_CONFIG = {
  host: 'host.example',
  port: 22,
  username: 'user',
  keyFile: undefined,
  remoteDir: '/srv/app'
}

describe('buildReadRemoteFileArgs', () => {
  it('joins remote dir with relative path and uses cat', () => {
    const args = buildReadRemoteFileArgs(SOCKET_DIR, 'proj-1', SSH_CONFIG, 'README.md')
    expect(args).toContain('cat')
    const lastArg = args[args.length - 1]
    expect(lastArg).toMatch(/\/srv\/app\/README\.md/)
  })

  it('quotes paths containing spaces', () => {
    const args = buildReadRemoteFileArgs(SOCKET_DIR, 'proj-1', { ...SSH_CONFIG, remoteDir: '/srv/my app' }, 'README.md')
    const cmd = args.slice(args.indexOf('cat') - 0).join(' ')
    expect(cmd).toContain('cat')
    expect(cmd).toMatch(/'\/srv\/my app\/README\.md'|"\/srv\/my app\/README\.md"/)
  })

  it('uses the per-project control socket', () => {
    const args = buildReadRemoteFileArgs(SOCKET_DIR, 'proj-1', SSH_CONFIG, 'README.md')
    const sFlag = args.indexOf('-S')
    expect(sFlag).toBeGreaterThanOrEqual(0)
    expect(args[sFlag + 1]).toContain('proj-1')
  })

  it('targets the configured user@host', () => {
    const args = buildReadRemoteFileArgs(SOCKET_DIR, 'proj-1', SSH_CONFIG, 'README.md')
    expect(args.some(a => a === 'user@host.example')).toBe(true)
  })
})

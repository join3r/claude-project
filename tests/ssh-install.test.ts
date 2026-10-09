import { describe, expect, it } from 'vitest'
import {
  MarkerFilter,
  SSH_INSTALL_DATA,
  SSH_INSTALL_EXIT,
  SshInstallSessions,
  buildSshInstallArgs,
  describeSshTarget,
  remoteInstallScript,
  sshTargetProblem,
  type PtyLike
} from '../src/main/servers/ssh-install'
import { ClientRegistry } from '../src/server/client-registry'
import { registerSshInstallHandlers, type SshInstallControl } from '../src/main/ipc/servers'

const TOKEN = 'AQEsecretsecretsecretsecretsecretsecret.24.21.0'
const NONCE = '0123456789abcdef'

class FakePty implements PtyLike {
  written: string[] = []
  killed = false
  size: [number, number] = [0, 0]
  private dataListeners: ((data: string) => void)[] = []
  private exitListeners: ((event: { exitCode: number }) => void)[] = []
  onData(listener: (data: string) => void): void { this.dataListeners.push(listener) }
  onExit(listener: (event: { exitCode: number }) => void): void { this.exitListeners.push(listener) }
  write(data: string): void { this.written.push(data) }
  resize(cols: number, rows: number): void { this.size = [cols, rows] }
  kill(): void { this.killed = true; this.exit(129) }
  emit(data: string): void { for (const listener of this.dataListeners) listener(data) }
  exit(exitCode: number): void { for (const listener of this.exitListeners) listener({ exitCode }) }
}

function setup(options: { installUrl?: string } = {}) {
  const ptys: Array<{ file: string; args: string[]; env: Record<string, string>; pty: FakePty }> = []
  const sent: Array<{ clientId: string; channel: string; args: unknown[] }> = []
  let tokens = 0
  const sessions = new SshInstallSessions({
    spawn: (file, args, opts) => {
      const pty = new FakePty()
      ptys.push({ file, args, env: opts.env, pty })
      return pty
    },
    send: (clientId, channel, ...args) => sent.push({ clientId, channel, args }),
    token: () => { tokens++; return TOKEN },
    installUrl: () => options.installUrl ?? 'https://devtool.awantech.sk',
    ssh: () => '/usr/bin/ssh',
    env: () => ({ PATH: '/usr/bin', HOME: '/home/me' }),
    log: () => {},
    nonce: () => NONCE
  })
  const output = (clientId = 'win:1') => sent.filter((m) => m.channel === SSH_INSTALL_DATA && m.clientId === clientId).map((m) => m.args[1]).join('')
  return { sessions, ptys, sent, output, tokens: () => tokens }
}

describe('ssh install arguments', () => {
  it('forces a tty and passes user, port and key as options, the script as one argument', () => {
    const script = remoteInstallScript('https://devtool.awantech.sk', NONCE)
    const args = buildSshInstallArgs({ host: 'dev.example.com', user: 'deploy', port: 2222, keyFile: '/k/id_ed25519' }, script)
    expect(args).toEqual(['-tt', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-p', '2222', '-i', '/k/id_ed25519', '-l', 'deploy', 'dev.example.com', script])
    expect(buildSshInstallArgs({ host: 'orb', user: 'devtool-srv-test', port: 22 }, script)).toEqual(['-tt', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-l', 'devtool-srv-test', 'orb', script])
  })

  it('never puts the token in the local or remote command line', () => {
    const { sessions, ptys, tokens } = setup({ installUrl: 'http://host.orb.internal:8799/' })
    sessions.start('win:1', { host: 'orb', user: 'devtool-srv-test' }, { cols: 100, rows: 30 })
    const [{ file, args, env, pty }] = ptys
    // Nothing asked for the token before the remote was ready.
    expect(tokens()).toBe(0)
    pty.emit(`DEVTOOL-SSH-READY-${NONCE}\r\n`)
    expect(tokens()).toBe(1)
    expect(pty.written).toEqual([`${TOKEN}\n`])
    for (const text of [file, ...args, ...Object.values(env)]) expect(text).not.toContain(TOKEN.slice(0, 20))
    // The remote side: the script reads the token and hands it over in the environment only.
    const script = args[args.length - 1]
    expect(script).toBe(
      'sh -c \'stty -echo 2>/dev/null; command -v curl >/dev/null 2>&1 || { stty echo 2>/dev/null; echo "DEVTOOL-SSH-NOCURL""-0123456789abcdef"; exit 3; }; ' +
      'echo "DEVTOOL-SSH-READY""-0123456789abcdef"; IFS= read -r t; stty echo 2>/dev/null; ' +
      'curl -fsSL "http://host.orb.internal:8799/install" | DEVTOOL_INSTALL_URL="http://host.orb.internal:8799" DEVTOOL_TOKEN="$t" sh\''
    )
    // Inside the single quotes: nothing a login shell (sh, fish, csh) would treat specially.
    const inner = script.slice("sh -c '".length, -1)
    expect(inner).not.toMatch(/['\\!\n]/)
    // The marker as printed is not in the command, so an echo of the command can't trigger it.
    expect(script).not.toContain(`DEVTOOL-SSH-READY-${NONCE}`)
  })

  it('leaves the install URL out for the default site', () => {
    const script = remoteInstallScript('https://devtool.awantech.sk/', NONCE)
    expect(script).toContain('curl -fsSL "https://devtool.awantech.sk/install" | DEVTOOL_TOKEN="$t" sh')
    expect(script).not.toContain('DEVTOOL_INSTALL_URL')
  })

  it('refuses targets that ssh would read as options, and URLs that would break the quoting', () => {
    expect(sshTargetProblem({ host: '-oProxyCommand=evil' })).toMatch(/host/)
    expect(sshTargetProblem({ host: 'box', user: '-l' })).toMatch(/user/)
    expect(sshTargetProblem({ host: 'box', port: 70000 })).toMatch(/port/)
    expect(sshTargetProblem({ host: 'box name' })).toMatch(/host/)
    expect(sshTargetProblem({ host: 'fe80::1%en0', user: 'me@corp.example' })).toBeNull()
    expect(() => buildSshInstallArgs({ host: '-x' }, 'sh')).toThrow(/host/)
    expect(() => remoteInstallScript('https://evil.example/$(id)', NONCE)).toThrow(/install URL/)
    expect(() => remoteInstallScript('https://evil.example/"x', NONCE)).toThrow(/install URL/)
    expect(describeSshTarget({ host: 'box', user: 'me', port: 2222 })).toBe('me@box:2222')
    expect(describeSshTarget({ host: 'fe80::1' })).toBe('[fe80::1]')
  })
})

describe('ssh install sessions', () => {
  it('hides the marker, sends the token once, and forwards everything else to its window', () => {
    const { sessions, ptys, sent, output } = setup()
    const { sessionId } = sessions.start('win:1', { host: 'box' }, { cols: 80, rows: 24 })
    const { pty } = ptys[0]
    pty.emit('me@box\'s password: ')
    pty.emit('\r\nWelcome\r\nDEVTOOL-SSH-RE')
    expect(output()).toBe('me@box\'s password: \r\nWelcome\r\n')
    pty.emit(`ADY-${NONCE}`)
    pty.emit('\r\n')
    pty.emit('Downloading Node 24.21.0...\r\n')
    pty.emit(`echoed ${TOKEN}\r\n`)
    pty.emit(`DEVTOOL-SSH-READY-${NONCE}\r\n`)
    expect(pty.written).toEqual([`${TOKEN}\n`])
    // After the first marker nothing is held or stripped; a token that comes back anyway is hidden.
    expect(output()).toBe(`me@box's password: \r\nWelcome\r\nDownloading Node 24.21.0...\r\nechoed [token hidden]\r\nDEVTOOL-SSH-READY-${NONCE}\r\n`)
    pty.exit(0)
    expect(sent.at(-1)).toEqual({ clientId: 'win:1', channel: SSH_INSTALL_EXIT, args: [sessionId, { exitCode: 0, reason: null, tokenSent: true }] })
  })

  it('reports a missing curl without sending the token', () => {
    const { sessions, ptys, sent, output, tokens } = setup()
    const { sessionId } = sessions.start('win:1', { host: 'box' }, { cols: 80, rows: 24 })
    ptys[0].pty.emit(`DEVTOOL-SSH-NOCURL-${NONCE}\r\n`)
    ptys[0].pty.exit(3)
    expect(tokens()).toBe(0)
    expect(output()).toBe('')
    expect(sent.at(-1)?.args).toEqual([sessionId, { exitCode: 3, reason: 'no-curl', tokenSent: false }])
  })

  it('only the starting window may type into, resize or stop a session; a closed window stops its own', () => {
    const { sessions, ptys, sent } = setup()
    const { sessionId } = sessions.start('win:1', { host: 'box' }, { cols: 80, rows: 24 })
    const { pty } = ptys[0]
    sessions.write('win:2', sessionId, 'x')
    sessions.resize('win:2', sessionId, 120, 40)
    sessions.stop('win:2', sessionId)
    expect(pty.written).toEqual([])
    expect(pty.killed).toBe(false)
    sessions.write('win:1', sessionId, 'yes\r')
    sessions.resize('win:1', sessionId, 120, 40)
    expect(pty.written).toEqual(['yes\r'])
    expect(pty.size).toEqual([120, 40])
    sessions.detachClient('win:1')
    expect(pty.killed).toBe(true)
    expect(sent.at(-1)?.args[1]).toMatchObject({ reason: 'stopped' })
  })

  it('goes through the registrar with checked arguments', async () => {
    const calls: unknown[][] = []
    const control: SshInstallControl = {
      start: (clientId, target, size) => { calls.push(['start', clientId, target, size]); return { sessionId: 'ssh-install-1', target: target.host } },
      write: (clientId, id, data) => { calls.push(['write', clientId, id, data]) },
      resize: (clientId, id, cols, rows) => { calls.push(['resize', clientId, id, cols, rows]) },
      stop: (clientId, id) => { calls.push(['stop', clientId, id]) }
    }
    const registry = new ClientRegistry({ onClientGone: () => {}, log: () => {} })
    registerSshInstallHandlers(registry.createRegistrar(() => {}), { sshInstalls: () => control })
    registry.registerClient('win:1', () => {})
    const call = (ch: string, ...args: unknown[]) => registry.call('win:1', ch, args)
    await expect(call('servers-ssh-install-start', { host: 'box', user: 'me', port: 22, token: 'sneaky' }, { cols: 80, rows: 24 })).resolves.toEqual({ sessionId: 'ssh-install-1', target: 'box' })
    await call('servers-ssh-install-input', 'ssh-install-1', 'y\r')
    await call('servers-ssh-install-resize', 'ssh-install-1', 100, 30)
    await call('servers-ssh-install-stop', 'ssh-install-1')
    await expect(call('servers-ssh-install-start', { host: 'box', port: 0 }, { cols: 80, rows: 24 })).rejects.toThrow()
    await expect(call('servers-ssh-install-stop', '../x')).rejects.toThrow()
    expect(calls).toEqual([
      ['start', 'win:1', { host: 'box', user: 'me', port: 22 }, { cols: 80, rows: 24 }],
      ['write', 'win:1', 'ssh-install-1', 'y\r'],
      ['resize', 'win:1', 'ssh-install-1', 100, 30],
      ['stop', 'win:1', 'ssh-install-1']
    ])
  })
})

describe('MarkerFilter', () => {
  it('drops a marker split across chunks along with its line break, even when the break comes later', () => {
    const filter = new MarkerFilter(['MARK-1'])
    const seen: string[] = []
    const push = (text: string) => filter.push(text, (m) => seen.push(m))
    expect(push('abc MA')).toBe('abc ')
    expect(push('RK-1')).toBe('')
    expect(push('\r')).toBe('')
    expect(push('\nnext')).toBe('next')
    expect(push('MARK-1 again')).toBe('MARK-1 again')
    expect(seen).toEqual(['MARK-1'])
  })

  it('lets text through that only looks like the start of a marker', () => {
    const filter = new MarkerFilter(['MARK-1'])
    expect(filter.push('MA', () => {})).toBe('')
    expect(filter.push('X', () => {})).toBe('MAX')
    expect(filter.push('end M', () => {})).toBe('end ')
    expect(filter.flush()).toBe('M')
  })
})

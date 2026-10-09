import { execFile, execFileSync } from 'child_process'
import { once } from 'events'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServerIde, desktopKeyComment, type ServerIdeDeps } from '../src/main/servers/server-ide'
import { sshSocketPath } from '../src/main/servers/server-ssh-sockets'
import { authorizeDesktopKey, revokeDesktopKey, type SshKeyHome } from '../src/main/host-ssh-keys'
import { TcpConnectError } from '../src/main/host/link/tcp-stream'
import { NODE_PROXY_SCRIPT, ncSpeaksUnix } from '../src/main/servers/ssh-proxy-command'
import type { ServersState, ServerStatus } from '../src/shared/servers'
import type { ExternalEditor } from '../src/shared/types'
import { tcpLoopback } from './helpers/tcp-loopback'

/**
 * Open in IDE for server projects, desktop side (plan step 9): consent state,
 * the setup, DevTool's ssh config and known_hosts, the socket that pipes ssh to
 * the server's sshd over a `tcp` stream, opening, forgetting and revoking.
 */

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SERVER = 'ab'.repeat(16)

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A fake sshd on 127.0.0.1: says its banner, then echoes. */
async function fakeSshd(): Promise<number> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.write('SSH-2.0-OpenSSH_fake\r\n')
    socket.pipe(socket)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()) }))
  return (server.address() as net.AddressInfo).port
}

function status(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    id: SERVER, name: 'Box', state: 'online', pairedAt: 1, lastSeen: 1, build: null,
    host: { os: 'linux', arch: 'arm64', hostname: 'box-host', node: '24.21.0', user: 'dev' },
    ...overrides
  }
}

interface Rig {
  ide: ServerIde
  configDir: string
  userConfig: string
  serverHome: SshKeyHome
  launched: { alias: string; folder: string }[]
  calls: string[]
  state: { servers: ServerStatus[] }
}

/** A ServerIde whose server is a loopback link with `tcp`; the server's port 22 is `sshdPort` here. */
async function rig(options: { sshdPort?: number | null; nc?: string | null; platform?: NodeJS.Platform } = {}): Promise<Rig> {
  const root = tempDir('dt-ide-')
  // Short enough for a socket path in the config dir itself.
  const configDir = path.join(root, 'c')
  const home = path.join(root, 'home')
  const serverHome: SshKeyHome = { home: path.join(root, 'srv'), user: 'dev', hostKeyDir: path.join(root, 'etc') }
  fs.mkdirSync(serverHome.hostKeyDir, { recursive: true })
  fs.writeFileSync(path.join(serverHome.hostKeyDir, 'ssh_host_ed25519_key.pub'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKey root@box\n')
  const loop = tcpLoopback()
  cleanups.push(() => loop.close())
  const state = { servers: [status()] }
  const launched: Rig['launched'] = []
  const calls: string[] = []
  const deps: ServerIdeDeps = {
    configDir,
    userSshConfig: path.join(home, '.ssh', 'config'),
    home,
    platform: options.platform ?? 'darwin',
    servers: () => ({ relay: { kind: 'online' }, servers: state.servers, invite: null }) as ServersState,
    call: async (_serverId, ch, args) => {
      calls.push(ch)
      const request = args[1] as { publicKey: string; comment: string }
      if (ch === 'host-ssh-authorize-key') return authorizeDesktopKey(request, serverHome)
      if (ch === 'host-ssh-revoke-key') return revokeDesktopKey(request.publicKey, serverHome)
      throw new Error(`unexpected ${ch}`)
    },
    openTcp: async (serverId, target) => {
      if (options.sshdPort === null) throw new TcpConnectError('ECONNREFUSED', 'ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:22')
      return loop.openTcp(serverId, { ...target, port: options.sshdPort ?? target.port })
    },
    desktopName: () => 'Test Mac',
    execPath: process.execPath,
    launch: async (_editor, alias, folder) => { launched.push({ alias, folder }) },
    log: () => {},
    findNc: async () => (options.nc === undefined ? '/usr/bin/nc' : options.nc),
    keygen: async (file, comment) => { execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]) },
    now: () => new Date('2026-10-09T10:00:00Z')
  }
  const ide = new ServerIde(deps)
  cleanups.push(() => ide.stop())
  return { ide, configDir, userConfig: deps.userSshConfig, serverHome, launched, calls, state }
}

const editor: ExternalEditor = { id: 'code', name: 'Visual Studio Code', command: 'code', extraArgs: '' }
const mode = (file: string) => fs.statSync(file).mode & 0o777

/** The first line a socket says. */
async function firstLine(socketPath: string): Promise<string> {
  const conn = net.connect(socketPath)
  conn.on('error', () => {})
  let text = ''
  for await (const chunk of conn) {
    text += (chunk as Buffer).toString()
    if (text.includes('\n')) break
  }
  conn.destroy()
  return text
}

describe.skipIf(process.platform === 'win32')('Open in IDE for server projects', () => {
  it('says plainly when the server has no sshd', async () => {
    const { ide } = await rig({ sshdPort: null })
    await expect(ide.state(SERVER)).rejects.toThrow('Open in IDE needs an SSH server on Box. Install openssh-server there.')
  })

  it('refuses on a Windows desktop and for an offline server', async () => {
    const win = await rig({ platform: 'win32', sshdPort: await fakeSshd() })
    await expect(win.ide.state(SERVER)).rejects.toThrow(/macOS or Linux/)
    const offline = await rig({ sshdPort: await fakeSshd() })
    offline.state.servers = [status({ state: 'offline' })]
    await expect(offline.ide.state(SERVER)).rejects.toThrow(/not connected/)
  })

  it('asks for both parts first, then sets up: the Include, the key on the server, the Host block and the socket', async () => {
    const sshd = await fakeSshd()
    const r = await rig({ sshdPort: sshd })
    expect(await r.ide.state(SERVER)).toMatchObject({ serverName: 'Box', needsInclude: true, needsKey: true, userSshConfig: r.userConfig })
    await expect(r.ide.open(editor, SERVER, '/home/dev/app')).rejects.toThrow(/isn't set up yet/)
    expect(r.launched).toEqual([])

    const after = await r.ide.setup(SERVER, { include: true, key: true })
    expect(after).toMatchObject({ needsInclude: false, needsKey: false })

    // (a) the Include, in a config DevTool created
    expect(fs.readFileSync(r.userConfig, 'utf8')).toContain(`Include ${path.join(r.configDir, 'ssh', 'config')}`)
    // (b) the key on the server, restricted to its own loopback, with the desktop's name
    const authorized = fs.readFileSync(path.join(r.serverHome.home, '.ssh', 'authorized_keys'), 'utf8')
    expect(authorized).toMatch(/^from="127\.0\.0\.1,::1" ssh-ed25519 \S+ devtool-Test-Mac\n$/)
    expect(authorized).toContain(fs.readFileSync(path.join(r.configDir, 'ssh', 'id_ed25519.pub'), 'utf8').split(' ')[1])

    const sshDir = path.join(r.configDir, 'ssh')
    const socket = r.ide.socketPath(SERVER)
    const config = fs.readFileSync(path.join(sshDir, 'config'), 'utf8')
    expect(config).toContain('Host devtool-box\n  HostName box-host\n  User dev\n')
    expect(config).toContain(`  ProxyCommand /usr/bin/nc -U ${socket}\n`)
    expect(config).toContain(`  IdentityFile ${path.join(sshDir, 'id_ed25519')}\n  IdentitiesOnly yes\n  HostKeyAlias devtool-box\n`)
    expect(fs.readFileSync(path.join(sshDir, 'known_hosts'), 'utf8')).toBe('devtool-box ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKey\n')
    expect(mode(sshDir)).toBe(0o700)
    expect(mode(path.join(sshDir, 'config'))).toBe(0o600)
    expect(mode(path.dirname(socket))).toBe(0o700)
    expect(fs.lstatSync(socket).isSocket()).toBe(true)
    expect(mode(socket)).toBe(0o600)

    // The socket reaches the server's sshd through the tcp stream.
    expect(await firstLine(socket)).toBe('SSH-2.0-OpenSSH_fake\r\n')
  })

  it('opens the editor on the alias, re-authorizing quietly (idempotent) each time', async () => {
    const r = await rig({ sshdPort: await fakeSshd() })
    await r.ide.setup(SERVER, { include: true, key: true })
    await r.ide.open(editor, SERVER, '/home/dev/my app')
    await r.ide.open(editor, SERVER, '/home/dev/my app')
    expect(r.launched).toEqual([{ alias: 'devtool-box', folder: '/home/dev/my app' }, { alias: 'devtool-box', folder: '/home/dev/my app' }])
    expect(r.calls.filter((c) => c === 'host-ssh-authorize-key')).toHaveLength(3)
    expect(fs.readFileSync(path.join(r.serverHome.home, '.ssh', 'authorized_keys'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('keeps an alias when the server is renamed, and survives a restart of DevTool', async () => {
    const r = await rig({ sshdPort: await fakeSshd() })
    await r.ide.setup(SERVER, { include: true, key: true })
    r.state.servers = [status({ name: 'Renamed' })]
    await r.ide.open(editor, SERVER, '/srv')
    expect(r.launched.at(-1)?.alias).toBe('devtool-box')
    await r.ide.stop()
    const again = new ServerIde({
      configDir: r.configDir, userSshConfig: r.userConfig, home: '/nowhere', platform: 'darwin',
      servers: () => ({ relay: { kind: 'online' }, servers: r.state.servers, invite: null }),
      call: async () => ({ user: 'dev', home: '/', added: false, hostKeys: [] }),
      openTcp: async () => { throw new Error('unused') },
      desktopName: () => 'x', execPath: process.execPath, launch: async () => {}, log: () => {},
      findNc: async () => '/usr/bin/nc'
    })
    cleanups.push(() => again.stop())
    await again.start()
    expect(again.aliasOf(SERVER)).toBe('devtool-box')
    expect(fs.lstatSync(again.socketPath(SERVER)).isSocket()).toBe(true)
  })

  it('removing the server: revokes the key while online, then drops its Host block, keys and socket', async () => {
    const r = await rig({ sshdPort: await fakeSshd() })
    await r.ide.setup(SERVER, { include: true, key: true })
    const socket = r.ide.socketPath(SERVER)
    expect(await r.ide.revoke(SERVER)).toBe(true)
    expect(fs.readFileSync(path.join(r.serverHome.home, '.ssh', 'authorized_keys'), 'utf8').trim()).toBe('')
    r.state.servers = []
    r.ide.serversChanged({ relay: { kind: 'online' }, servers: [], invite: null })
    await expect.poll(() => fs.readFileSync(path.join(r.configDir, 'ssh', 'config'), 'utf8').includes('Host ')).toBe(false)
    await expect.poll(() => fs.existsSync(socket)).toBe(false)
    expect(fs.readFileSync(path.join(r.configDir, 'ssh', 'known_hosts'), 'utf8')).toBe('')
    expect(r.ide.aliasOf(SERVER)).toBeUndefined()
    // The Include stays: it names a file that now has no hosts.
    expect(fs.readFileSync(r.userConfig, 'utf8')).toContain('Include ')
  })

  it('offline at removal: the key stays (it only works from the server itself)', async () => {
    const r = await rig({ sshdPort: await fakeSshd() })
    await r.ide.setup(SERVER, { include: true, key: true })
    r.state.servers = [status({ state: 'offline' })]
    expect(await r.ide.revoke(SERVER)).toBe(false)
    expect(r.calls).not.toContain('host-ssh-revoke-key')
  })

  it('falls back to a Node ProxyCommand when nc has no -U, and that proxy reaches sshd', async () => {
    const r = await rig({ sshdPort: await fakeSshd(), nc: null })
    await r.ide.setup(SERVER, { include: true, key: true })
    const config = fs.readFileSync(path.join(r.configDir, 'ssh', 'config'), 'utf8')
    const script = path.join(r.configDir, 'ssh', NODE_PROXY_SCRIPT)
    const socket = r.ide.socketPath(SERVER)
    expect(config).toContain(`  ProxyCommand /usr/bin/env ELECTRON_RUN_AS_NODE=1 ${process.execPath} ${script} ${socket}\n`)
    // Async: this process serves the socket and the fake sshd.
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile('/usr/bin/env', ['ELECTRON_RUN_AS_NODE=1', process.execPath, script, socket], { encoding: 'utf8', timeout: 10_000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)))
      child.stdin?.end()
    })
    expect(out.startsWith('SSH-2.0-OpenSSH_fake')).toBe(true)
  })

  it('tries nc -U for real before trusting it', async () => {
    if (process.platform === 'darwin') expect(await ncSpeaksUnix('/usr/bin/nc')).toBe(true)
    expect(await ncSpeaksUnix('/bin/echo')).toBe(false)
    expect(await ncSpeaksUnix('/no/such/nc')).toBe(false)
  })

  it('names the key after the desktop', () => {
    expect(desktopKeyComment('Join\'s MacBook Pro')).toBe('devtool-Join-s-MacBook-Pro')
    expect(desktopKeyComment('')).toBe('devtool-desktop')
  })

  it('puts the socket in a private temp dir when the config dir path is too long', () => {
    const long = '/x'.repeat(60)
    expect(sshSocketPath(long, SERVER, () => '/tmp/devtool-ssh-abc')).toBe(`/tmp/devtool-ssh-abc/${SERVER.slice(0, 16)}.sock`)
    expect(sshSocketPath('/Users/me/.devtool', SERVER, () => '/unused')).toBe(`/Users/me/.devtool/servers/${SERVER}/ssh.sock`)
  })
})

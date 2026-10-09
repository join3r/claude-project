import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import type { ExternalEditor } from '../../shared/types'
import type { ServersState } from '../../shared/servers'
import { SERVER_IDE_WINDOWS_MESSAGE, sshServerMissingMessage, type ServerIdeConsent, type ServerIdeState } from '../../shared/server-ide'
import { atomicWriteFileSync } from '../atomic-write'
import { TcpConnectError, type TcpTarget } from '../host/link/tcp-stream'
import type { LinkStream } from '../host/link/stream'
import {
  aliasForServer,
  ensureUserSshInclude,
  hasInclude,
  renderDevtoolSshConfig,
  renderHostBlock,
  renderKnownHosts,
  type SshHostEntry
} from './ssh-config'
import { ServerSshSockets, SSHD_TARGET, ensurePrivateDir } from './server-ssh-sockets'
import { findUnixNc, proxyCommandFactory, type ProxyCommandFor } from './ssh-proxy-command'

const execFileAsync = promisify(execFile)

/** How long the sshd probe waits for the server's banner. */
const BANNER_TIMEOUT_MS = 5000
/** Removing a server waits at most this long for it to drop the key. */
const REVOKE_TIMEOUT_MS = 3000

export interface ServerIdeDeps {
  configDir: string
  /** The user's ssh config (`~/.ssh/config`; `DEVTOOL_USER_SSH_CONFIG` overrides it for tests). */
  userSshConfig: string
  /** The user's home, to recognise `~/` in an existing Include. */
  home: string
  platform: NodeJS.Platform
  servers: () => ServersState
  /** A host channel on the server, called as main. */
  call: (serverId: string, ch: string, args: unknown[]) => Promise<unknown>
  /** A connected `tcp` stream on the server. */
  openTcp: (serverId: string, target: TcpTarget) => Promise<LinkStream>
  desktopName: () => string
  /** This app's binary, run as Node by the fallback ProxyCommand. */
  execPath: string
  launch: (editor: ExternalEditor, alias: string, folder: string) => Promise<void>
  log: (message: string) => void
  /** Tests: the nc that speaks Unix sockets, or none. */
  findNc?: () => Promise<string | null>
  /** Tests: makes the key pair (`ssh-keygen`). */
  keygen?: (file: string, comment: string) => Promise<void>
  now?: () => Date
}

interface Registry {
  v: 1
  hosts: SshHostEntry[]
}

interface AuthorizeAnswer {
  user: string
  home: string
  added: boolean
  hostKeys: string[]
}

function isAuthorizeAnswer(value: unknown): value is AuthorizeAnswer {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return typeof o.user === 'string' && Array.isArray(o.hostKeys) && o.hostKeys.every((k) => typeof k === 'string')
}

function isEntry(value: unknown): value is SshHostEntry {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return typeof o.serverId === 'string' && /^[0-9a-f]{32}$/.test(o.serverId)
    && typeof o.alias === 'string' && /^devtool-[a-z0-9-]+$/.test(o.alias)
    && typeof o.hostName === 'string' && typeof o.user === 'string'
    && Array.isArray(o.hostKeys) && o.hostKeys.every((k) => typeof k === 'string')
}

/** `devtool-<desktop name>`: the key's comment, so the server's owner can tell whose it is. */
export function desktopKeyComment(desktopName: string): string {
  const clean = desktopName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  return `devtool-${clean || 'desktop'}`
}

async function sshKeygen(file: string, comment: string): Promise<void> {
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { timeout: 15_000 })
}

/**
 * Open in IDE for server projects (plan step 9). DevTool's ssh config
 * (`<configDir>/ssh/config`, from `<configDir>/ssh/hosts.json`) has a
 * `Host devtool-<slug>` per set-up server whose ProxyCommand reaches this
 * desktop's socket for it ({@link ServerSshSockets}), which pipes to the
 * server's sshd over a `tcp` stream. First use asks the user (the window does)
 * to Include that file from `~/.ssh/config` and to authorize DevTool's key on
 * the server; after that every Open in IDE re-authorizes (idempotent, and it
 * refreshes the pinned host keys), rewrites the config and opens the editor.
 */
export class ServerIde {
  readonly sshDir: string
  readonly devtoolSshConfig: string
  readonly identityFile: string
  readonly knownHostsFile: string
  private readonly registryFile: string
  private readonly sockets: ServerSshSockets
  private entries: SshHostEntry[]
  private proxyFor: Promise<ProxyCommandFor> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly deps: ServerIdeDeps) {
    this.sshDir = path.join(deps.configDir, 'ssh')
    this.devtoolSshConfig = path.join(this.sshDir, 'config')
    this.identityFile = path.join(this.sshDir, 'id_ed25519')
    this.knownHostsFile = path.join(this.sshDir, 'known_hosts')
    this.registryFile = path.join(this.sshDir, 'hosts.json')
    this.sockets = new ServerSshSockets({ configDir: deps.configDir, openTcp: deps.openTcp, log: deps.log })
    this.entries = this.readRegistry()
  }

  /** At startup: listens for every set-up server that is still paired, and rewrites the config for this run's sockets. */
  async start(): Promise<void> {
    if (this.deps.platform === 'win32') return
    this.prune(this.deps.servers())
    if (this.entries.length > 0) await this.writeConfig()
  }

  /** The hub's state changed: a server that left it is forgotten. */
  serversChanged(state: ServersState): void {
    if (this.prune(state)) void this.writeConfig().catch((err: unknown) => this.deps.log(`serverIde config error=${String(err)}`))
  }

  /** What still needs the user's OK. Checks first that the server is online and runs an sshd. */
  async state(serverId: string): Promise<ServerIdeState> {
    const server = this.requireServer(serverId)
    await this.probeSshd(serverId, server.name)
    return this.currentState(serverId, server.name)
  }

  /** Does what the user agreed to: the Include, and the key on the server (with its host entry). */
  async setup(serverId: string, consent: ServerIdeConsent): Promise<ServerIdeState> {
    const server = this.requireServer(serverId)
    if (consent.include) {
      const result = ensureUserSshInclude(this.deps.userSshConfig, this.devtoolSshConfig, { home: this.deps.home, now: this.deps.now?.() })
      if (result.changed) this.deps.log(`serverIde include added to ${this.deps.userSshConfig}${result.backup ? ` backup=${result.backup}` : ''}${result.created ? ' (created)' : ''}`)
    }
    if (consent.key) await this.authorize(serverId, server.name)
    return this.currentState(serverId, server.name)
  }

  /** Opens `folder` on the server in `editor`. Throws when the setup isn't done (the window asks first). */
  async open(editor: ExternalEditor, serverId: string, folder: string): Promise<void> {
    const server = this.requireServer(serverId)
    const state = this.currentState(serverId, server.name)
    if (state.needsInclude || state.needsKey) throw new Error(`Open in IDE on ${server.name} isn't set up yet`)
    await this.probeSshd(serverId, server.name)
    const entry = await this.authorize(serverId, server.name)
    await this.deps.launch(editor, entry.alias, folder)
    this.deps.log(`serverIde opened server=${serverId} alias=${entry.alias} folder=${folder}`)
  }

  /** Where this run listens for a server's ssh connections. */
  socketPath(serverId: string): string {
    return this.sockets.socketPath(serverId)
  }

  /** The ssh alias of a set-up server. */
  aliasOf(serverId: string): string | undefined {
    return this.entries.find((e) => e.serverId === serverId)?.alias
  }

  /**
   * Before a server is removed: if it is set up and online, it drops DevTool's
   * key (best effort, capped). Offline, the key stays there: it only works from
   * the server itself (`from="127.0.0.1,::1"`).
   */
  async revoke(serverId: string): Promise<boolean> {
    if (!this.aliasOf(serverId)) return false
    const online = this.deps.servers().servers.some((s) => s.id === serverId && s.state === 'online')
    if (!online || !fs.existsSync(`${this.identityFile}.pub`)) return false
    const publicKey = fs.readFileSync(`${this.identityFile}.pub`, 'utf8').trim()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answer = await Promise.race([
        this.deps.call(serverId, 'host-ssh-revoke-key', [serverId, { publicKey }]),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timed out')), REVOKE_TIMEOUT_MS) })
      ]) as { removed?: boolean } | null
      this.deps.log(`serverIde revoked server=${serverId} removed=${answer?.removed === true}`)
      return answer?.removed === true
    } catch (err) {
      this.deps.log(`serverIde revoke server=${serverId} failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** The server is gone: its Host block, pinned keys and socket go too. */
  async forget(serverId: string): Promise<void> {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.serverId !== serverId)
    await this.sockets.close(serverId)
    if (this.entries.length !== before) {
      this.saveRegistry()
      await this.writeConfig()
      this.deps.log(`serverIde forgot server=${serverId}`)
    }
  }

  async stop(): Promise<void> {
    await this.sockets.stop()
  }

  // ---- internals ----------------------------------------------------------------------

  private requireServer(serverId: string): { name: string; host: ServersState['servers'][number]['host'] } {
    if (this.deps.platform === 'win32') throw new Error(SERVER_IDE_WINDOWS_MESSAGE)
    const server = this.deps.servers().servers.find((s) => s.id === serverId)
    if (!server) throw new Error('No such server')
    if (server.state !== 'online') throw new Error(`${server.name} is not connected; Open in IDE needs it online`)
    return { name: server.name, host: server.host }
  }

  private currentState(serverId: string, serverName: string): ServerIdeState {
    let userConfig = ''
    try {
      userConfig = fs.readFileSync(this.deps.userSshConfig, 'utf8')
    } catch {
      // No ssh config yet.
    }
    return {
      serverId,
      serverName,
      needsInclude: !hasInclude(userConfig, this.devtoolSshConfig, this.deps.home),
      needsKey: !this.aliasOf(serverId),
      userSshConfig: this.deps.userSshConfig,
      devtoolSshConfig: this.devtoolSshConfig
    }
  }

  /** Something on the server's 127.0.0.1:22 that says `SSH-`; the plain message when nothing listens. */
  private async probeSshd(serverId: string, serverName: string): Promise<void> {
    let stream: LinkStream
    try {
      stream = await this.deps.openTcp(serverId, SSHD_TARGET)
    } catch (err) {
      if (err instanceof TcpConnectError && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH')) {
        throw new Error(sshServerMissingMessage(serverName), { cause: err })
      }
      throw err
    }
    try {
      const banner = await new Promise<string>((resolve, reject) => {
        let text = ''
        const timer = setTimeout(() => reject(new Error(`The server on port 22 of ${serverName} didn't answer like an SSH server`)), BANNER_TIMEOUT_MS)
        stream.on('data', (chunk: Buffer) => {
          text += chunk.toString('latin1')
          if (text.includes('\n') || text.length >= 255) {
            clearTimeout(timer)
            resolve(text)
          }
        })
        stream.once('end', () => {
          clearTimeout(timer)
          resolve(text)
        })
        stream.once('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        stream.resume()
      })
      if (!banner.startsWith('SSH-')) throw new Error(`Port 22 on ${serverName} isn't an SSH server. ${sshServerMissingMessage(serverName)}`)
    } finally {
      stream.destroy()
    }
  }

  /** Our key on the server (idempotent), and the server's entry and pinned host keys here. */
  private async authorize(serverId: string, serverName: string): Promise<SshHostEntry> {
    const publicKey = await this.ensureKey()
    const answer = await this.deps.call(serverId, 'host-ssh-authorize-key', [serverId, { publicKey, comment: desktopKeyComment(this.deps.desktopName()) }])
    if (!isAuthorizeAnswer(answer)) throw new Error(`${serverName} gave no answer about DevTool's key`)
    if (answer.added) this.deps.log(`serverIde key authorized on server=${serverId} user=${answer.user}`)
    const status = this.deps.servers().servers.find((s) => s.id === serverId)
    const existing = this.entries.find((e) => e.serverId === serverId)
    const entry: SshHostEntry = {
      serverId,
      alias: existing?.alias ?? aliasForServer(serverName, serverId, this.entries.map((e) => e.alias)),
      hostName: status?.host?.hostname ?? existing?.hostName ?? '',
      user: answer.user || status?.host?.user || existing?.user || '',
      hostKeys: answer.hostKeys
    }
    this.entries = [...this.entries.filter((e) => e.serverId !== serverId), entry]
    this.saveRegistry()
    await this.writeConfig()
    return entry
  }

  /** `<configDir>/ssh/id_ed25519`, made with ssh-keygen on first use. Answers the public key line. */
  private async ensureKey(): Promise<string> {
    ensurePrivateDir(this.sshDir)
    const pub = `${this.identityFile}.pub`
    if (!fs.existsSync(this.identityFile)) {
      fs.rmSync(pub, { force: true })
      await (this.deps.keygen ?? sshKeygen)(this.identityFile, desktopKeyComment(this.deps.desktopName()))
      this.deps.log(`serverIde key made ${this.identityFile}`)
    } else if (!fs.existsSync(pub)) {
      const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', this.identityFile], { timeout: 15_000 })
      atomicWriteFileSync(pub, stdout.trim() + '\n', 0o644)
    }
    return fs.readFileSync(pub, 'utf8').trim()
  }

  /** Drops entries of servers that aren't paired any more. Answers whether any went. */
  private prune(state: ServersState): boolean {
    const paired = new Set(state.servers.map((s) => s.id))
    const gone = this.entries.filter((e) => !paired.has(e.serverId))
    if (gone.length === 0) return false
    this.entries = this.entries.filter((e) => paired.has(e.serverId))
    this.saveRegistry()
    for (const entry of gone) void this.sockets.close(entry.serverId)
    return true
  }

  private proxyCommand(): Promise<ProxyCommandFor> {
    this.proxyFor ??= (async () => {
      const nc = await (this.deps.findNc ?? (() => findUnixNc()))()
      this.deps.log(`serverIde proxyCommand ${nc ? `nc=${nc}` : `node=${this.deps.execPath}`}`)
      return proxyCommandFactory({ nc, execPath: this.deps.execPath, sshDir: this.sshDir })
    })()
    return this.proxyFor
  }

  /** Listens for every entry and writes DevTool's ssh config and known_hosts for those sockets. */
  private writeConfig(): Promise<void> {
    const run = this.writing.catch(() => {}).then(async () => {
      ensurePrivateDir(this.sshDir)
      const proxyFor = await this.proxyCommand()
      const blocks: string[] = []
      for (const entry of this.entries) {
        const socket = await this.sockets.ensure(entry.serverId)
        blocks.push(renderHostBlock(entry, proxyFor(socket), { identityFile: this.identityFile, knownHostsFile: this.knownHostsFile }))
      }
      atomicWriteFileSync(this.devtoolSshConfig, renderDevtoolSshConfig(blocks), 0o600)
      atomicWriteFileSync(this.knownHostsFile, renderKnownHosts(this.entries), 0o600)
    })
    this.writing = run
    return run
  }

  private readRegistry(): SshHostEntry[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.registryFile, 'utf8')) as Partial<Registry>
      return Array.isArray(value.hosts) ? value.hosts.filter(isEntry) : []
    } catch {
      return []
    }
  }

  private saveRegistry(): void {
    ensurePrivateDir(this.sshDir)
    const registry: Registry = { v: 1, hosts: this.entries }
    atomicWriteFileSync(this.registryFile, JSON.stringify(registry, null, 2), 0o600)
  }
}

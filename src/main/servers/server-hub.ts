import path from 'path'
import { b64uDecode, b64uEncode, derivePairProof, deriveRelayToken } from '../../../protocol/ts/index.ts'
import type { ErrorMessage, PeerMessage, VersionInfo } from '../../../protocol/ts/index.ts'
import type { DesktopIdentity } from '../mobile/identity'
import type { RelayTransportState } from '../mobile/mobile-service'
import { LinkError, LinkErrorCode, errorMessage } from '../host/link/errors'
import { buildHello, type LinkBuild } from '../host/link/handshake'
import {
  PAIRING_REJECTION_TEXT,
  PAIRING_VERSION,
  PairFrame,
  PairingError,
  PairingInitiator,
  PairingOffer,
  answerPairing,
  decodeTicket,
  encodeTicket,
  helloProof,
  isTicketExpired,
  type PairingReply
} from '../host/link/pairing'
import { HUB_CLIENT, LinkChannel } from '../host/link/link-channels'
import type { HostLinkPort, RelayMux } from '../host/link/relay-mux'
import type { LinkStream } from '../host/link/stream'
import { HOST_LINK_MIN_VERSION, HOST_LINK_PROTOCOL_VERSION } from '../host/link/version'
import { normalizeRelayUrl } from '../../shared/mobile'
import {
  DEFAULT_INSTALL_URL,
  RELAY_TOO_OLD_FOR_SERVERS,
  installOneLiner,
  type ServerDeviceCode,
  type ServerInvite,
  type ServerInviteState,
  type ServerStatus,
  type ServersRelayKind,
  type ServersState
} from '../../shared/servers'
import { ServerConnection, type ConnectionTimers } from './server-connection'
import { PeerStore, type PeerRecord } from '../host/link/peer-store'

/** A push from a server: `client` is the local window it is for (`win:N`), or `*` for every window. */
export interface ServerEvent {
  serverId: string
  client: string
  ch: string
  args: unknown[]
}

export interface ServerHubDeps {
  configDir: string
  relay: RelayMux
  /** This desktop's identity; loaded only once a server is paired. */
  identity: { get(): DesktopIdentity }
  /** The relay to use (today the Mobile setting's; 5b makes it a shared Relay setting). */
  relayUrl: () => string
  build: LinkBuild
  desktopName: () => string
  log: (message: string) => void
  /** Where the install script lives, for the one-liner (`DEVTOOL_INSTALL_URL`). */
  installUrl?: () => string
  /** The Node version an install token asks for (the bundled server's manifest). */
  serverNode?: () => string
  timers?: ConnectionTimers
  /** Tests: speak another protocol version range. */
  version?: VersionInfo
}

/** The Node version an install token names when the desktop carries no server bundle. */
export const FALLBACK_SERVER_NODE = '24.21.0'
/** How long `pairWithCode` waits for the relay, then for the server's answer. */
const RELAY_WAIT_MS = 15_000
const PAIRING_ANSWER_MS = 20_000

interface LiveInvite extends ServerInviteState {
  offer: PairingOffer
}

interface CodePairing {
  initiator: PairingInitiator
  resolve: (reply: PairingReply) => void
  reject: (error: PairingError) => void
}

const realTimers: ConnectionTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * The desktop's DevTool servers: one {@link ServerConnection} per paired server,
 * on the relay socket the phones use too (only the servers' frames come here).
 * The socket is wanted while any server is paired; the hub `watch`es them all
 * with one list, handshakes with each one the relay reports online, and routes
 * calls, events and streams.
 */
export class ServerHub {
  private readonly store: PeerStore
  private readonly port: HostLinkPort
  private readonly timers: ConnectionTimers
  private readonly version: VersionInfo
  private readonly connections = new Map<string, ServerConnection>()
  private readonly eventListeners = new Set<(event: ServerEvent) => void>()
  private readonly stateListeners = new Set<(state: ServersState) => void>()
  /** Code flow: servers this desktop is proving a code to; their frames come here until then. */
  private readonly codePairings = new Map<string, CodePairing>()
  private readonly onlineWaiters = new Set<() => void>()
  /** The live install invite (token flow), at most one. */
  private invite: LiveInvite | null = null
  private inviteTimer: unknown = null
  /** Servers the relay reported on since the socket came up; the others get re-watched after a handshake. */
  private readonly reported = new Set<string>()
  private started = false
  private lastStateKey = ''

  constructor(private readonly deps: ServerHubDeps) {
    this.timers = deps.timers ?? realTimers
    this.version = deps.version ?? { v: HOST_LINK_PROTOCOL_VERSION, min: HOST_LINK_MIN_VERSION }
    this.store = new PeerStore(path.join(deps.configDir, 'servers'), 'servers.json', deps.log)
    this.port = deps.relay.hostPort((peerId) => this.store.has(peerId) || this.codePairings.has(peerId), {
      frame: (from, envelope) => this.onFrame(from, envelope),
      peer: (message) => this.onPeer(message),
      error: (message) => this.onRelayError(message),
      pairing: (from, envelope) => this.answerInstallHello(from, envelope.subarray(1))
    })
    this.port.onStateChange((state) => this.onRelayState(state))
    this.port.onOfferTaken(() => {
      if (this.invite?.status !== 'waiting') return
      this.deps.log('servers invite replaced by a phone pairing QR')
      this.clearInvite()
      this.syncSocket()
      this.emitState()
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    for (const record of this.store.list()) this.addConnection(record)
    this.syncSocket()
    this.emitState()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    for (const connection of this.connections.values()) connection.stop()
    this.connections.clear()
    for (const [serverId, pairing] of [...this.codePairings]) {
      this.codePairings.delete(serverId)
      pairing.reject(new PairingError('cancelled', 'DevTool is quitting'))
    }
    this.clearInvite()
    this.port.close()
  }

  getState(): ServersState {
    const relay = this.relayState()
    const servers: ServerStatus[] = this.store.list()
      .sort((a, b) => a.pairedAt - b.pairedAt)
      .map((record) => {
        const status = this.connections.get(record.id)?.status() ?? { state: 'offline' as const }
        return {
          id: record.id,
          name: record.name,
          ...status,
          pairedAt: record.pairedAt,
          lastSeen: record.lastSeen,
          build: record.build ?? null,
          host: record.host ?? null
        }
      })
    const invite = this.invite
    return {
      relay,
      servers,
      invite: invite
        ? { oneLiner: invite.oneLiner, token: invite.token, expiresAt: invite.expiresAt, status: invite.status, ...(invite.serverId ? { serverId: invite.serverId } : {}) }
        : null
    }
  }

  /** Runs `ch` on the server as the local window `clientId`. Rejects with LinkError (`server-offline` when not connected). */
  call(serverId: string, clientId: string, ch: string, args: unknown[] = [], options: { focused?: boolean } = {}): Promise<unknown> {
    const connection = this.connections.get(serverId)
    if (!connection) return Promise.reject(new LinkError(LinkErrorCode.ServerOffline, 'No such server'))
    return connection.call(clientId, ch, args, options.focused ?? false)
  }

  /**
   * A stream of `kind` to the server; throws LinkError `server-offline` when it isn't
   * connected. It is destroyed with a LinkError when the link drops, so listen for `error`.
   */
  openStream(serverId: string, kind: string, params: unknown = null): LinkStream {
    const connection = this.connections.get(serverId)
    if (!connection) throw new LinkError(LinkErrorCode.ServerOffline, 'No such server')
    return connection.openStream(kind, params)
  }

  /** A local window closed: every server lets go of what it held for it. */
  detachClient(clientId: string): void {
    for (const connection of this.connections.values()) connection.detach(clientId)
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  onStateChange(listener: (state: ServersState) => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  /** The relay URL setting may have changed. */
  relayUrlChanged(): void {
    this.syncSocket()
  }

  // ---- pairing (protocol/SERVER.md §7) -----------------------------------------------

  /**
   * Token flow: mints an install invite (15 minutes, single use) and offers it at
   * the relay. It replaces an earlier invite and the phone QR, which share the
   * relay's one offer. The new server pairs on its own; no Accept click.
   */
  createInvite(): ServerInvite {
    const identity = this.deps.identity.get()
    const now = this.timers.now()
    const offer = PairingOffer.mint(now)
    const token = encodeTicket({
      kind: 'install',
      relay: this.deps.relayUrl(),
      id: identity.id,
      x25519Pub: identity.x25519.pub,
      ed25519Pub: identity.ed25519.pub,
      secret: offer.secret,
      exp: offer.exp,
      name: this.deps.desktopName(),
      node: this.deps.serverNode?.() || FALLBACK_SERVER_NODE
    })
    this.clearInvite()
    const expiresAt = offer.exp * 1000
    this.invite = { offer, token, oneLiner: installOneLiner(token, this.deps.installUrl?.() ?? DEFAULT_INSTALL_URL), expiresAt, status: 'waiting' }
    this.inviteTimer = this.timers.setTimeout(() => {
      this.inviteTimer = null
      if (this.invite?.offer !== offer) return
      this.invite = null
      this.syncSocket()
      this.emitState()
    }, Math.max(0, expiresAt - now))
    this.deps.log(`servers invite offered exp=${new Date(expiresAt).toISOString()}`)
    this.syncSocket()
    this.sendInviteOffer()
    this.emitState()
    return { oneLiner: this.invite.oneLiner, token, expiresAt }
  }

  cancelInvite(): void {
    if (!this.invite) return
    this.clearInvite()
    this.syncSocket()
    this.emitState()
  }

  /**
   * Code flow: pairs with the server whose `devtool-server pair` code this is, then
   * connects. Rejects with a readable error (expired, wrong relay, used code...).
   */
  async pairWithCode(text: string): Promise<ServerStatus> {
    const ticket = decodeTicket(text, 'device')
    if (isTicketExpired(ticket, this.timers.now())) throw new PairingError('expired', 'This pairing code has expired. Run devtool-server pair on the server again.')
    const relayUrl = normalizeRelayUrl(this.deps.relayUrl())
    if (ticket.relay !== relayUrl) {
      throw new PairingError('relay-refused', `This server uses the relay ${ticket.relay}, but DevTool uses ${relayUrl}. Use the same relay on both.`)
    }
    if (!this.started) throw new PairingError('cancelled', 'Servers are not running')
    const serverId = ticket.id
    this.codePairings.get(serverId)?.reject(new PairingError('cancelled', 'Another pairing with this server started'))
    const identity = this.deps.identity.get()
    const initiator = new PairingInitiator(identity.x25519, ticket.x25519Pub)
    const replyPromise = new Promise<PairingReply>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (this.codePairings.get(serverId)?.initiator !== initiator) return
        this.codePairings.delete(serverId)
        this.syncSocket()
        reject(new PairingError('timeout', 'The server did not answer. Is devtool-server running there?'))
      }, PAIRING_ANSWER_MS + RELAY_WAIT_MS)
      this.codePairings.set(serverId, {
        initiator,
        resolve: (reply) => { this.timers.clearTimeout(timer); resolve(reply) },
        reject: (error) => { this.timers.clearTimeout(timer); reject(error) }
      })
    })
    // Keep the rejection from going unhandled while we wait for the relay.
    replyPromise.catch(() => {})
    this.syncSocket()
    try {
      await this.whenRelayOnline(RELAY_WAIT_MS)
    } catch (err) {
      this.codePairings.get(serverId)?.reject(err as PairingError)
      this.codePairings.delete(serverId)
      this.syncSocket()
      throw err
    }
    this.port.send({ t: 'pair', to: serverId, token: b64uEncode(deriveRelayToken(ticket.secret)) })
    this.port.sendBinary(serverId, initiator.start({
      ...PAIRING_VERSION,
      app: 'devtool-desktop',
      proof: b64uEncode(derivePairProof(ticket.secret)),
      ed: b64uEncode(identity.ed25519.pub),
      name: this.deps.desktopName(),
      build: this.deps.build
    }))
    let reply: PairingReply
    try {
      reply = await replyPromise
    } finally {
      if (this.codePairings.get(serverId)?.initiator === initiator) this.codePairings.delete(serverId)
    }
    const now = this.timers.now()
    this.savePaired({
      id: serverId,
      name: reply.name || ticket.name || 'server',
      x25519Pub: b64uEncode(ticket.x25519Pub),
      ed25519Pub: b64uEncode(ticket.ed25519Pub),
      pairedAt: this.store.get(serverId)?.pairedAt ?? now,
      lastSeen: now,
      build: reply.build,
      ...(reply.host ? { host: reply.host } : {})
    })
    this.deps.log(`servers paired server=${serverId} name=${JSON.stringify(reply.name)} (code)`)
    return this.getState().servers.find((s) => s.id === serverId)!
  }

  /** "Add another device": the server mints a pairing code for another desktop. */
  async deviceCode(serverId: string): Promise<ServerDeviceCode> {
    const result = await this.call(serverId, HUB_CLIENT, LinkChannel.PairCode) as Partial<ServerDeviceCode> | null
    if (!result || typeof result.code !== 'string' || typeof result.expiresAt !== 'number') throw new LinkError(LinkErrorCode.Protocol, 'The server sent no code')
    return { code: result.code, expiresAt: result.expiresAt }
  }

  private onFrame(from: string, envelope: Uint8Array): void {
    if (envelope.length > 0 && envelope[0] === PairFrame.Reply) {
      this.finishCodePairing(from, envelope.subarray(1))
      return
    }
    if (envelope.length > 0 && envelope[0] === PairFrame.Hello) {
      // A paired server installed again with a new token.
      this.answerInstallHello(from, envelope.subarray(1))
      return
    }
    this.connections.get(from)?.receive(envelope)
  }

  private finishCodePairing(from: string, body: Uint8Array): void {
    const pairing = this.codePairings.get(from)
    if (!pairing) return
    this.codePairings.delete(from)
    let reply: PairingReply
    try {
      reply = pairing.initiator.finish(body)
    } catch (err) {
      pairing.reject(new PairingError('incompatible', `The server's answer was unreadable: ${errorMessage(err)}`))
      return
    }
    if (reply.result === 'ok') {
      pairing.resolve(reply)
    } else if (reply.result === 'incompatible') {
      pairing.reject(new PairingError('incompatible', 'This server cannot pair with this DevTool. Update both to the same release.'))
    } else {
      const reason = reply.reason ?? 'wrong-secret'
      pairing.reject(new PairingError(reason, `The server refused: ${PAIRING_REJECTION_TEXT[reason]}`))
    }
  }

  /** Token flow: a new server proves the secret of this desktop's invite. */
  private answerInstallHello(from: string, body: Uint8Array): void {
    const identity = this.deps.identity.get()
    const invite = this.invite
    let outcome: ReturnType<typeof answerPairing>
    try {
      outcome = answerPairing(
        identity.x25519,
        body,
        from,
        'devtool-server',
        () => ({ app: 'devtool-desktop', name: this.deps.desktopName(), build: this.deps.build }),
        ({ hello, remoteStatic }) => {
          if (!invite) return { result: 'rejected', reason: 'no-offer' }
          const proof = helloProof(hello)
          if (!proof) return { result: 'rejected', reason: 'wrong-secret' }
          const check = invite.offer.check(proof, { id: from, x25519Pub: b64uEncode(remoteStatic) }, this.timers.now())
          return check.ok ? { result: 'ok' } : { result: 'rejected', reason: check.reason }
        }
      )
    } catch (err) {
      this.deps.log(`servers pairing hello from=${from} unreadable: ${errorMessage(err)}`)
      return
    }
    this.port.sendBinary(from, outcome.envelope)
    const hello = outcome.hello
    this.deps.log(`servers pairing from=${from} result=${outcome.result}${outcome.reason ? ` reason=${outcome.reason}` : ''}${hello ? ` name=${JSON.stringify(hello.name)}` : ''}`)
    if (outcome.result !== 'ok' || !hello || !invite) return
    const now = this.timers.now()
    this.port.send({ t: 'authorize', peer: from, pub: hello.ed })
    invite.status = 'paired'
    invite.serverId = from
    this.savePaired({
      id: from,
      name: hello.name || hello.host?.hostname || 'server',
      x25519Pub: b64uEncode(outcome.remoteStatic),
      ed25519Pub: hello.ed,
      pairedAt: this.store.get(from)?.pairedAt ?? now,
      lastSeen: now,
      build: hello.build,
      ...(hello.host ? { host: hello.host } : {})
    })
  }

  /** Stores a freshly paired server and connects: it is online, it just talked to us. */
  private savePaired(record: PeerRecord): void {
    this.store.add(record)
    this.connections.get(record.id)?.stop()
    this.connections.delete(record.id)
    if (this.started) {
      this.addConnection(record)
      this.syncSocket()
      if (this.port.getState().kind === 'online') this.sendWatch()
      this.connections.get(record.id)?.serverOnline()
    }
    this.emitState()
  }

  private sendInviteOffer(): void {
    const invite = this.invite
    if (!invite || invite.status !== 'waiting' || invite.offer.consumed || invite.offer.expired(this.timers.now())) return
    if (this.port.getState().kind !== 'online' || !this.port.isBinary()) return
    this.port.send(invite.offer.offerMessage())
  }

  private clearInvite(): void {
    if (this.inviteTimer !== null) {
      this.timers.clearTimeout(this.inviteTimer)
      this.inviteTimer = null
    }
    this.invite = null
  }

  private whenRelayOnline(timeoutMs: number): Promise<void> {
    if (this.port.getState().kind === 'online') {
      return this.port.isBinary() ? Promise.resolve() : Promise.reject(new PairingError('relay-refused', RELAY_TOO_OLD_FOR_SERVERS))
    }
    return new Promise((resolve, reject) => {
      const done = () => {
        this.timers.clearTimeout(timer)
        this.onlineWaiters.delete(done)
        if (this.port.isBinary()) resolve()
        else reject(new PairingError('relay-refused', RELAY_TOO_OLD_FOR_SERVERS))
      }
      const timer = this.timers.setTimeout(() => {
        this.onlineWaiters.delete(done)
        const state = this.port.getState()
        const why = state.kind === 'offline' && state.error ? `: ${state.error}` : ''
        reject(new PairingError('relay-unreachable', `Cannot reach the relay at ${this.deps.relayUrl()}${why}`))
      }, timeoutMs)
      this.onlineWaiters.add(done)
    })
  }

  // ---- relay ---------------------------------------------------------------------------

  private addConnection(record: PeerRecord): void {
    const connection = new ServerConnection({
      id: record.id,
      serverStatic: () => b64uDecode(this.store.get(record.id)?.x25519Pub ?? record.x25519Pub),
      staticKey: () => this.deps.identity.get().x25519,
      hello: () => ({ ...buildHello('devtool-desktop', this.deps.build, this.deps.desktopName()), v: this.version.v, min: this.version.min }),
      version: this.version,
      port: this.port,
      timers: this.timers,
      log: (message) => this.deps.log(`servers ${message}`),
      onChange: () => this.emitState(),
      onEstablished: (reply) => {
        this.store.setBuild(record.id, reply.build)
        if (reply.host) this.store.setHost(record.id, reply.host)
        this.store.touchLastSeen(record.id, this.timers.now())
        // Paired after our last `watch` (the relay may have read it before the pair existed): watch again.
        if (!this.reported.has(record.id)) this.sendWatch()
        this.emitState()
      },
      onEvent: (event) => {
        const serverEvent: ServerEvent = { serverId: record.id, client: event.client, ch: event.ch, args: event.args }
        for (const listener of [...this.eventListeners]) {
          try {
            listener(serverEvent)
          } catch (err) {
            this.deps.log(`servers event listener error=${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    })
    this.connections.set(record.id, connection)
  }

  /** The socket is wanted while any server is paired, an invite is live or a code is being proven. */
  private syncSocket(): void {
    if (!this.started) return
    if (this.connections.size > 0 || this.invite || this.codePairings.size > 0) this.port.connect(this.deps.relayUrl())
    else this.port.close()
  }

  private onRelayState(state: RelayTransportState): void {
    this.reported.clear()
    if (state.kind !== 'online') {
      for (const connection of this.connections.values()) connection.serverOffline()
      this.emitState()
      return
    }
    for (const waiter of [...this.onlineWaiters]) waiter()
    if (!this.port.isBinary()) {
      this.deps.log(`servers ${RELAY_TOO_OLD_FOR_SERVERS}`)
      for (const connection of this.connections.values()) connection.serverOffline({ error: RELAY_TOO_OLD_FOR_SERVERS, problem: 'relay-too-old' })
      this.emitState()
      return
    }
    this.sendInviteOffer()
    this.sendWatch()
    this.emitState()
  }

  private sendWatch(): void {
    if (this.connections.size === 0) return
    this.port.send({ t: 'watch', desktops: [...this.connections.keys()] })
  }

  private onPeer(message: PeerMessage): void {
    const connection = this.connections.get(message.id)
    if (!connection) return
    this.reported.add(message.id)
    if (message.state === 'online') {
      this.store.touchLastSeen(message.id, this.timers.now())
      connection.serverOnline()
    } else if (message.state === 'revoked') {
      this.deps.log(`servers server=${message.id} revoked the pairing`)
      connection.serverOffline({ error: 'The server removed this desktop', problem: 'revoked' })
    } else {
      if (message.lastSeen !== undefined) this.store.touchLastSeen(message.id, message.lastSeen)
      connection.serverOffline()
    }
    this.emitState()
  }

  private onRelayError(message: ErrorMessage): void {
    const pairing = message.to ? this.codePairings.get(message.to) : undefined
    if (pairing && message.to && (message.code === 'forbidden' || message.code === 'offline')) {
      this.codePairings.delete(message.to)
      pairing.reject(message.code === 'forbidden'
        ? new PairingError('relay-refused', 'The relay refused this pairing code: it was already used, it expired, or the server made a new one')
        : new PairingError('peer-offline', 'The server is not connected to the relay'))
      this.syncSocket()
      return
    }
    const connection = message.to ? this.connections.get(message.to) : undefined
    if (connection && message.code === 'offline') {
      connection.serverOffline()
      this.emitState()
      return
    }
    this.deps.log(`servers relayError code=${message.code}${message.to ? ` to=${message.to}` : ''}${message.message ? ` message=${message.message}` : ''}`)
    if (connection && message.code === 'forbidden') {
      connection.serverOffline({ error: 'The relay has no pairing with this server' })
      this.emitState()
    }
  }

  private relayState(): ServersState['relay'] {
    if (this.connections.size === 0 && !this.invite && this.codePairings.size === 0) return { kind: 'idle' }
    const state = this.port.getState()
    let kind: ServersRelayKind
    switch (state.kind) {
      case 'online':
        kind = this.port.isBinary() ? 'online' : 'too-old'
        break
      case 'offline':
        kind = 'offline'
        break
      case 'connecting':
        kind = 'connecting'
        break
      default:
        kind = 'idle'
    }
    const error = state.kind === 'offline' ? state.error : kind === 'too-old' ? RELAY_TOO_OLD_FOR_SERVERS : undefined
    return error ? { kind, error } : { kind }
  }

  private emitState(): void {
    if (!this.started) return
    const state = this.getState()
    const key = JSON.stringify(state)
    if (key === this.lastStateKey) return
    this.lastStateKey = key
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state)
      } catch (err) {
        this.deps.log(`servers state listener error=${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

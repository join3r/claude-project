import path from 'path'
import { b64uDecode, b64uEncode } from '../../../protocol/ts/index.ts'
import type { ErrorMessage, PeerMessage, VersionInfo } from '../../../protocol/ts/index.ts'
import type { DesktopIdentity } from '../mobile/identity'
import type { RelayTransportState } from '../mobile/mobile-service'
import { decodeDevPairCode, encodeDevKeys } from '../host/link/dev-pair'
import { LinkError, LinkErrorCode } from '../host/link/errors'
import { buildHello, type LinkBuild } from '../host/link/handshake'
import type { HostLinkPort, RelayMux } from '../host/link/relay-mux'
import type { LinkStream } from '../host/link/stream'
import { HOST_LINK_MIN_VERSION, HOST_LINK_PROTOCOL_VERSION } from '../host/link/version'
import { RELAY_TOO_OLD_FOR_SERVERS, type ServerStatus, type ServersRelayKind, type ServersState } from '../../shared/servers'
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
  /** The relay to use (today the Mobile setting's; step 5 makes it a shared Relay setting). */
  relayUrl: () => string
  build: LinkBuild
  desktopName: () => string
  log: (message: string) => void
  timers?: ConnectionTimers
  /** Tests: speak another protocol version range. */
  version?: VersionInfo
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
  /** Relay `pair` messages a dev pairing still has to send (sent on the next `ready`). */
  private readonly pendingPairs = new Map<string, string>()
  /** Servers the relay reported on since the socket came up; the others get re-watched after a handshake. */
  private readonly reported = new Set<string>()
  private started = false
  private lastStateKey = ''

  constructor(private readonly deps: ServerHubDeps) {
    this.timers = deps.timers ?? realTimers
    this.version = deps.version ?? { v: HOST_LINK_PROTOCOL_VERSION, min: HOST_LINK_MIN_VERSION }
    this.store = new PeerStore(path.join(deps.configDir, 'servers'), 'servers.json', deps.log)
    this.port = deps.relay.hostPort((peerId) => this.store.has(peerId), {
      frame: (from, envelope) => this.connections.get(from)?.receive(envelope),
      peer: (message) => this.onPeer(message),
      error: (message) => this.onRelayError(message)
    })
    this.port.onStateChange((state) => this.onRelayState(state))
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
          build: record.build ?? null
        }
      })
    return { relay, servers }
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

  // ---- dev pairing (protocol/SERVER.md §7) ---------------------------------------------

  /** This desktop's public keys, for a server's `--dev-pair`. Loads (or creates) the identity. */
  devKeys(): string {
    const identity = this.deps.identity.get()
    return encodeDevKeys({ x25519Pub: b64uEncode(identity.x25519.pub), ed25519Pub: b64uEncode(identity.ed25519.pub) })
  }

  /** Takes a server's dev pairing code: stores the server, joins its relay offer and connects. */
  devPair(code: string): ServerStatus {
    const offer = decodeDevPairCode(code)
    const now = this.timers.now()
    const record: PeerRecord = {
      id: offer.id,
      name: offer.name,
      x25519Pub: offer.x25519Pub,
      ed25519Pub: offer.ed25519Pub,
      pairedAt: now,
      lastSeen: null
    }
    this.store.add(record)
    this.connections.get(record.id)?.stop()
    this.connections.delete(record.id)
    this.pendingPairs.set(record.id, offer.token)
    this.deps.log(`servers devPair server=${record.id} name=${record.name}`)
    if (this.started) {
      this.addConnection(record)
      this.syncSocket()
      if (this.port.getState().kind === 'online') this.sendPairs()
    }
    this.emitState()
    return this.getState().servers.find((s) => s.id === record.id)!
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
        this.store.touchLastSeen(record.id, this.timers.now())
        // Paired after our last `watch` (a dev pairing): watch again for its presence.
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

  /** The socket is wanted while any server is paired. */
  private syncSocket(): void {
    if (!this.started) return
    if (this.connections.size > 0) this.port.connect(this.deps.relayUrl())
    else this.port.close()
  }

  private onRelayState(state: RelayTransportState): void {
    this.reported.clear()
    if (state.kind !== 'online') {
      for (const connection of this.connections.values()) connection.serverOffline()
      this.emitState()
      return
    }
    if (!this.port.isBinary()) {
      this.deps.log(`servers ${RELAY_TOO_OLD_FOR_SERVERS}`)
      for (const connection of this.connections.values()) connection.serverOffline({ error: RELAY_TOO_OLD_FOR_SERVERS, problem: 'relay-too-old' })
      this.emitState()
      return
    }
    this.sendPairs()
    this.sendWatch()
    this.emitState()
  }

  private sendWatch(): void {
    if (this.connections.size === 0) return
    this.port.send({ t: 'watch', desktops: [...this.connections.keys()] })
  }

  /** Dev pairings: join the server's offer, then handshake without waiting for presence (the pair is pending). */
  private sendPairs(): void {
    for (const [serverId, token] of [...this.pendingPairs]) {
      if (!this.port.send({ t: 'pair', to: serverId, token })) continue
      this.pendingPairs.delete(serverId)
      this.connections.get(serverId)?.serverOnline()
    }
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
    if (this.connections.size === 0) return { kind: 'idle' }
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

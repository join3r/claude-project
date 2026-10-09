import { once } from 'events'
import fs from 'fs'
import path from 'path'
import { finished } from 'stream/promises'
import { b64uDecode, b64uEncode, derivePairProof, deriveRelayToken } from '../../../protocol/ts/index.ts'
import type { ErrorMessage, PeerMessage, VersionInfo } from '../../../protocol/ts/index.ts'
import type { DesktopIdentity } from '../mobile/identity'
import type { RelayTransportState } from '../mobile/mobile-service'
import { LinkError, LinkErrorCode, errorMessage } from '../host/link/errors'
import { buildHello, type HostLinkReply, type LinkBuild } from '../host/link/handshake'
import { packBundle, type LocalBundle } from '../host/link/bundle-archive'
import { decideUpdate, type UpdateDecision } from '../host/link/update-policy'
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
import { HUB_CLIENT, LinkChannel, LinkEvent, type ServerInfo } from '../host/link/link-channels'
import type { HostLinkPort, RelayMux } from '../host/link/relay-mux'
import type { LinkStream } from '../host/link/stream'
import { HOST_LINK_MIN_VERSION, HOST_LINK_PROTOCOL_VERSION } from '../host/link/version'
import { normalizeRelayUrl } from '../../shared/mobile'
import {
  DEFAULT_INSTALL_URL,
  RELAY_TOO_OLD_FOR_SERVERS,
  installOneLiner,
  type ServerDeviceCode,
  type ServerRemoveOptions,
  type ServerInvite,
  type ServerInviteState,
  type ServerStatus,
  type ServersRelayKind,
  type ServersState
} from '../../shared/servers'
import { ServerConnection, type ConnectionTimers } from './server-connection'
import { PeerStore, type PeerRecord } from '../host/link/peer-store'
import { atomicWriteFileSync } from '../atomic-write'

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
  /** The desktop's own build; commit, builtAt and bundleSha come from {@link bundle} when there is one. */
  build: LinkBuild
  desktopName: () => string
  log: (message: string) => void
  /** Where the install script lives, for the one-liner (`DEVTOOL_INSTALL_URL`). */
  installUrl?: () => string
  /** The server bundle this desktop carries, which it installs on and uploads to its servers. */
  bundle?: () => LocalBundle | null
  timers?: ConnectionTimers
  /** Tests: speak another protocol version range. */
  version?: VersionInfo
}

/** The Node version an install token names when the desktop carries no server bundle. */
export const FALLBACK_SERVER_NODE = '24.21.0'
/** How long a server that said it is restarting into an update shows as `updating`. */
const RESTART_GRACE_MS = 120_000
/** How often an upload's progress reaches the windows. */
const PROGRESS_STEP_BYTES = 256 * 1024
/** An upload that makes no progress for this long is given up (and tried again on the next connect). */
const UPLOAD_STALL_MS = 60_000
/** After the last byte: the server verifies, maybe fetches a Node, then answers. */
const UPLOAD_ANSWER_MS = 10 * 60_000
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
  /** Bundle uploads in flight: bytes sent and total. */
  private readonly uploads = new Map<string, { sent: number; total: number }>()
  /** Servers restarting into an update: shown as `updating` until they're back, or this time passes. */
  private readonly restarting = new Map<string, { until: number; timer: unknown }>()
  /** What each server last said about its updates. */
  private readonly infos = new Map<string, ServerInfo>()
  /** Servers whose last handshake was the installer's (`bootstrap`): their service hasn't connected yet. */
  private readonly installing = new Set<string>()
  /** A bundle sha a server refused: not sent again to it until DevTool restarts. */
  private readonly failedUploads = new Map<string, string>()
  /** Servers removed while the relay was away: revoked at the next `ready` (`servers/pending-revokes.json`). */
  private readonly pendingRevokesFile: string
  private pendingRevokes: Set<string>
  /** Servers the relay reported on since the socket came up; the others get re-watched after a handshake. */
  private readonly reported = new Set<string>()
  /** Run before a server is removed, while its link may still be up (Open in IDE drops its key). */
  private readonly removeHooks = new Set<(serverId: string) => Promise<unknown>>()
  private started = false
  private lastStateKey = ''

  constructor(private readonly deps: ServerHubDeps) {
    this.timers = deps.timers ?? realTimers
    this.version = deps.version ?? { v: HOST_LINK_PROTOCOL_VERSION, min: HOST_LINK_MIN_VERSION }
    this.store = new PeerStore(path.join(deps.configDir, 'servers'), 'servers.json', deps.log)
    this.pendingRevokesFile = path.join(deps.configDir, 'servers', 'pending-revokes.json')
    this.pendingRevokes = new Set(readIdList(this.pendingRevokesFile))
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
    for (const serverId of [...this.restarting.keys()]) this.endRestarting(serverId)
    for (const connection of this.connections.values()) connection.stop()
    this.connections.clear()
    for (const [serverId, pairing] of [...this.codePairings]) {
      this.codePairings.delete(serverId)
      pairing.reject(new PairingError('cancelled', 'DevTool is quitting'))
    }
    this.clearInvite()
    this.port.close()
  }

  /** What the handshakes say about this desktop: its version and the bundle it carries. */
  private build(): LinkBuild {
    const manifest = this.deps.bundle?.()?.manifest
    return manifest
      ? { version: this.deps.build.version, commit: manifest.commit, builtAt: manifest.builtAt, bundleSha: manifest.sha256 }
      : this.deps.build
  }

  getState(): ServersState {
    const relay = this.relayState()
    const servers: ServerStatus[] = this.store.list()
      .sort((a, b) => a.pairedAt - b.pairedAt)
      .map((record) => {
        const status = this.connections.get(record.id)?.status() ?? { state: 'offline' as const }
        const upload = this.uploads.get(record.id)
        const restarting = this.restarting.has(record.id)
        const update = this.infos.get(record.id)?.update
        return {
          id: record.id,
          name: record.name,
          ...status,
          // An upload rides a live link, so the server stays usable (`upload` shows progress);
          // `updating` is the restart into the new build, when the link is about to drop.
          ...(restarting && status.state !== 'incompatible' ? { state: 'updating' as const } : {}),
          ...(upload ? { upload: { ...upload } } : {}),
          ...(this.installing.has(record.id) ? { installing: true } : {}),
          ...(update?.state === 'staged' && !restarting ? { updateReady: { version: update.version, commit: update.commit, builtAt: update.builtAt } } : {}),
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

  /** `hook` runs (awaited, errors logged) at the start of every {@link remove}. */
  onBeforeRemove(hook: (serverId: string) => Promise<unknown>): () => void {
    this.removeHooks.add(hook)
    return () => { this.removeHooks.delete(hook) }
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
      node: this.deps.bundle?.()?.manifest.node || FALLBACK_SERVER_NODE
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
      build: this.build()
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
      // Paired again: keep the name this desktop gave it.
      name: this.store.get(serverId)?.name || reply.name || ticket.name || 'server',
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

  // ---- updates (protocol/SERVER.md §10) -------------------------------------------------

  /**
   * Checks the server's build against this desktop's bundle and uploads it when it
   * is newer. Runs on every connect; "Update" in Settings calls it too.
   */
  async updateServer(serverId: string): Promise<UpdateDecision> {
    const record = this.store.get(serverId)
    if (!record?.build) throw new LinkError(LinkErrorCode.ServerOffline, 'The server has not connected yet')
    this.failedUploads.delete(serverId)
    return this.maybeUpload(serverId, record.build)
  }

  /** Restarts the server now, switching to a staged update if it has one. */
  async restartServer(serverId: string): Promise<void> {
    await this.call(serverId, HUB_CLIENT, LinkChannel.Restart)
    this.startRestarting(serverId)
  }

  private async afterConnect(serverId: string, reply: HostLinkReply): Promise<void> {
    const bootstrap = reply.features.includes('bootstrap')
    let uploaded = false
    try {
      if (!bootstrap) await this.refreshInfo(serverId)
      const decision = await this.maybeUpload(serverId, reply.build)
      uploaded = decision.upload
    } catch (err) {
      this.deps.log(`servers server=${serverId} update check failed: ${errorMessage(err)}`)
    }
    if (!bootstrap) return
    // The bootstrap installs the service once the desktop says it is done.
    try {
      await this.call(serverId, HUB_CLIENT, LinkChannel.BootstrapDone, [{ uploaded }])
    } catch (err) {
      this.deps.log(`servers server=${serverId} bootstrap-done failed: ${errorMessage(err)}`)
    }
  }

  private async refreshInfo(serverId: string): Promise<void> {
    try {
      this.setInfo(serverId, await this.call(serverId, HUB_CLIENT, LinkChannel.Info))
    } catch (err) {
      // A server from before updates answers `unsupported`.
      if (!(err instanceof LinkError && err.code === LinkErrorCode.Unsupported)) throw err
    }
  }

  private setInfo(serverId: string, value: unknown): void {
    const update = (value as Partial<ServerInfo> | null)?.update
    const info: ServerInfo = {
      update: update && typeof update === 'object' && (update.state === 'staged' || update.state === 'restarting')
        ? { state: update.state, version: String(update.version ?? ''), commit: String(update.commit ?? ''), builtAt: String(update.builtAt ?? '') }
        : null
    }
    this.infos.set(serverId, info)
    if (info.update?.state === 'restarting') this.startRestarting(serverId)
    this.emitState()
  }

  private async maybeUpload(serverId: string, build: LinkBuild): Promise<UpdateDecision> {
    const bundle = this.deps.bundle?.() ?? null
    const decision = decideUpdate(bundle?.manifest ?? null, build)
    if (!decision.upload || !bundle) {
      this.deps.log(`servers server=${serverId} update=${decision.reason}`)
      return decision
    }
    if (this.failedUploads.get(serverId) === bundle.manifest.sha256) {
      this.deps.log(`servers server=${serverId} update=${decision.reason} skipped: this bundle failed before`)
      return { upload: false, reason: decision.reason }
    }
    if (this.uploads.has(serverId)) return { upload: false, reason: decision.reason }
    this.deps.log(`servers server=${serverId} update=${decision.reason} uploading version=${bundle.manifest.version} sha=${bundle.manifest.sha256.slice(0, 12)}`)
    const ok = await this.upload(serverId, bundle)
    return { upload: ok, reason: decision.reason }
  }

  private async upload(serverId: string, bundle: LocalBundle): Promise<boolean> {
    const archive = packBundle(bundle.dir)
    const progress = { sent: 0, total: archive.total }
    this.uploads.set(serverId, progress)
    this.emitState()
    const started = this.timers.now()
    let stream: LinkStream | null = null
    try {
      const { version, commit, builtAt, sha256 } = bundle.manifest
      stream = this.openStream(serverId, 'bundle', { version, commit, builtAt, sha256, bytes: archive.total })
      const replyChunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => replyChunks.push(chunk))
      const done = finished(stream)
      done.catch(() => {})
      let reported = 0
      for await (const chunk of archive.chunks()) {
        if (stream.destroyed) break
        if (!stream.write(chunk)) await this.within(Promise.race([once(stream, 'drain'), done]), UPLOAD_STALL_MS, 'The upload to the server stalled')
        progress.sent += chunk.length
        if (progress.sent - reported >= PROGRESS_STEP_BYTES) {
          reported = progress.sent
          this.emitState()
        }
      }
      stream.end()
      await this.within(done, UPLOAD_ANSWER_MS, 'The server did not confirm the upload')
      const result = JSON.parse(Buffer.concat(replyChunks).toString('utf8')) as { ok?: boolean; state?: string }
      this.deps.log(`servers server=${serverId} uploaded ${archive.total} bytes in ${this.timers.now() - started} ms state=${result.state}`)
      if (result.state === 'restarting') this.startRestarting(serverId)
      else if (result.state === 'staged') await this.refreshInfo(serverId).catch(() => {})
      return true
    } catch (err) {
      stream?.destroy()
      // Offline or stalled: worth another try on the next connect. Anything else (the server refused it): not this bundle again.
      const transient = err instanceof LinkError && (err.code === LinkErrorCode.ServerOffline || err.code === LinkErrorCode.Aborted)
      if (!transient) this.failedUploads.set(serverId, bundle.manifest.sha256)
      this.deps.log(`servers server=${serverId} upload failed: ${errorMessage(err)}`)
      return false
    } finally {
      this.uploads.delete(serverId)
      this.emitState()
    }
  }

  /** `promise`, or a LinkError `aborted` after `ms`. */
  private within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: unknown = null
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = this.timers.setTimeout(() => reject(new LinkError(LinkErrorCode.Aborted, message)), ms) })
    ]).finally(() => this.timers.clearTimeout(timer))
  }

  private startRestarting(serverId: string): void {
    this.endRestarting(serverId)
    const timer = this.timers.setTimeout(() => {
      if (this.restarting.get(serverId)?.timer !== timer) return
      this.restarting.delete(serverId)
      this.emitState()
    }, RESTART_GRACE_MS)
    this.restarting.set(serverId, { until: this.timers.now() + RESTART_GRACE_MS, timer })
    this.emitState()
  }

  private endRestarting(serverId: string): void {
    const entry = this.restarting.get(serverId)
    if (!entry) return
    this.timers.clearTimeout(entry.timer)
    this.restarting.delete(serverId)
    const info = this.infos.get(serverId)
    if (info?.update?.state === 'restarting') this.infos.set(serverId, { update: null })
  }

  // ---- managing ---------------------------------------------------------------------------

  /** The name this desktop shows for the server (the server keeps its own). */
  rename(serverId: string, name: string): ServerStatus {
    const clean = name.trim().slice(0, 100)
    if (!clean) throw new Error('A server needs a name')
    if (!this.store.rename(serverId, clean)) throw new Error('No such server')
    this.emitState()
    return this.getState().servers.find((s) => s.id === serverId)!
  }

  /**
   * Forgets the server: revokes the relay pair (now, or at the next `ready`) and
   * drops its record. With `uninstall` and the server online, it first asks the
   * server to remove itself (`server-uninstall`), data included unless `keepData`.
   */
  async remove(serverId: string, options: ServerRemoveOptions = {}): Promise<{ uninstalled: boolean }> {
    if (!this.store.has(serverId)) throw new Error('No such server')
    for (const hook of [...this.removeHooks]) {
      await hook(serverId).catch((err: unknown) => this.deps.log(`servers server=${serverId} before-remove hook failed: ${errorMessage(err)}`))
    }
    let uninstalled = false
    if (options.uninstall) {
      try {
        await this.call(serverId, HUB_CLIENT, LinkChannel.Uninstall, [{ deleteData: !options.keepData }])
        uninstalled = true
      } catch (err) {
        this.deps.log(`servers server=${serverId} uninstall failed: ${errorMessage(err)}`)
      }
    }
    this.connections.get(serverId)?.stop()
    this.connections.delete(serverId)
    this.store.remove(serverId)
    this.infos.delete(serverId)
    this.installing.delete(serverId)
    this.failedUploads.delete(serverId)
    this.endRestarting(serverId)
    if (this.invite?.serverId === serverId) this.clearInvite()
    this.pendingRevokes.add(serverId)
    this.saveRevokes()
    this.deps.log(`servers removed server=${serverId} uninstalled=${uninstalled}`)
    // The socket stays up long enough to send the revoke.
    this.syncSocket()
    if (this.port.getState().kind === 'online') {
      this.sendRevokes()
      // Replaces the watch set, so the removed server leaves it too.
      if (this.port.isBinary()) this.port.send({ t: 'watch', desktops: [...this.connections.keys()] })
    }
    this.syncSocket()
    this.emitState()
    return { uninstalled }
  }

  private sendRevokes(): void {
    if (!this.port.isBinary()) return
    let changed = false
    for (const serverId of [...this.pendingRevokes]) {
      if (!this.port.send({ t: 'revoke', peer: serverId })) continue
      this.pendingRevokes.delete(serverId)
      changed = true
    }
    if (changed) this.saveRevokes()
  }

  private saveRevokes(): void {
    try {
      fs.mkdirSync(path.dirname(this.pendingRevokesFile), { recursive: true, mode: 0o700 })
      atomicWriteFileSync(this.pendingRevokesFile, JSON.stringify([...this.pendingRevokes]), 0o600)
    } catch (err) {
      this.deps.log(`servers pending revokes not saved: ${errorMessage(err)}`)
    }
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
        () => ({ app: 'devtool-desktop', name: this.deps.desktopName(), build: this.build() }),
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
      name: this.store.get(from)?.name || hello.name || hello.host?.hostname || 'server',
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
      hello: () => ({ ...buildHello('devtool-desktop', this.build(), this.deps.desktopName()), v: this.version.v, min: this.version.min }),
      version: this.version,
      port: this.port,
      timers: this.timers,
      log: (message) => this.deps.log(`servers ${message}`),
      onChange: () => this.emitState(),
      onEstablished: (reply) => {
        this.store.setBuild(record.id, reply.build)
        if (reply.host) this.store.setHost(record.id, reply.host)
        this.store.touchLastSeen(record.id, this.timers.now())
        this.endRestarting(record.id)
        if (reply.features.includes('bootstrap')) this.installing.add(record.id)
        else this.installing.delete(record.id)
        // Paired after our last `watch` (the relay may have read it before the pair existed): watch again.
        if (!this.reported.has(record.id)) this.sendWatch()
        this.emitState()
        void this.afterConnect(record.id, reply)
      },
      onEvent: (event) => {
        if (event.ch === LinkEvent.Status) {
          this.setInfo(record.id, event.args[0])
          return
        }
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

  /** The socket is wanted while any server is paired, an invite is live, a code is being proven or a revoke waits. */
  private syncSocket(): void {
    if (!this.started) return
    if (this.connections.size > 0 || this.invite || this.codePairings.size > 0 || this.pendingRevokes.size > 0) this.port.connect(this.deps.relayUrl())
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
    this.sendRevokes()
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

function readIdList(file: string): string[] {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)) : []
  } catch {
    return []
  }
}

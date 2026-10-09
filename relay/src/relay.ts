import { randomBytes } from 'node:crypto'
import {
  ProtocolError,
  RELAY_BUFFER_HIGH_WATER_BYTES,
  RELAY_BUFFER_LOW_WATER_BYTES,
  RELAY_CONNECTIONS_PER_IP_PER_MINUTE,
  RELAY_HELLO_TIMEOUT_MS,
  RELAY_HOST_BUFFER_CAP_BYTES,
  RELAY_HOST_BYTES_BURST,
  RELAY_HOST_BYTES_PER_SECOND,
  RELAY_HOST_RATE_BURST,
  RELAY_HOST_RATE_PER_SECOND,
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_IP_BYTES_BURST,
  RELAY_IP_BYTES_PER_SECOND,
  RELAY_MAX_CONNECTIONS_PER_IP,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_PAIRS_PER_DEVICE,
  RELAY_MAX_PENDING_PER_DEVICE,
  RELAY_NEW_PAIRS_PER_IP_PER_HOUR,
  RELAY_PHONE_BUFFER_CAP_BYTES,
  RELAY_PUSH_RATE_BURST,
  RELAY_PUSH_RATE_PER_SECOND,
  RELAY_RATE_BURST,
  RELAY_RATE_PER_SECOND,
  RELAY_STALL_TIMEOUT_MS,
  RelayCloseCode,
  UnsupportedMessageError,
  b64uDecode,
  b64uEncode,
  constantTimeEqual,
  decodeRelayBinaryFrame,
  deviceId,
  encodeRelayBinaryFrame,
  encodeRelayMessage,
  pairTarget,
  parseClientMessage,
  sha256,
  verifyHello
} from '../../protocol/ts/index.ts'
import type {
  AuthorizeMessage,
  ClientMessage,
  OfferMessage,
  PairMessage,
  PeerState,
  PushMessage,
  PushResult,
  ReadyMessage,
  RelayErrorCode,
  RevokeMessage,
  Role,
  ServerMessage,
  WatchMessage
} from '../../protocol/ts/index.ts'
import { silentLogger } from './log.ts'
import type { Logger } from './log.ts'
import { IpLimiter, TokenBucket } from './rate.ts'
import type { Pair, RelayStore } from './store.ts'

/**
 * The relay core (§3), independent of any socket library: `server.ts` feeds it bytes
 * and close events, and it answers through the `Connection` it was given. All routing
 * state except the pairs table lives here, in memory.
 */

export interface RelayLimits {
  /** §3.5: larger messages close the socket with 1009. */
  maxFrameBytes: number
  helloTimeoutMs: number
  idleTimeoutMs: number
  /** Phones, and every socket until its hello: messages per second and burst. */
  ratePerSecond: number
  rateBurst: number
  /** A phone's second rate violation within this window of the first closes with 4429. */
  rateStrikeWindowMs: number
  /** Desktops and servers (§3.10): throttled, never refused. */
  hostRatePerSecond: number
  hostRateBurst: number
  hostBytesPerSecond: number
  hostBytesBurst: number
  /** Every connection from one IP shares this byte budget, throttled like a host's. */
  ipBytesPerSecond: number
  ipBytesBurst: number
  /** Pushes per connection; more are answered `rate`. */
  pushRatePerSecond: number
  pushRateBurst: number
  /** Backpressure (§3.10): a receiver queue over the high-water mark pauses its senders... */
  bufferHighWaterBytes: number
  /** ...until it is back at the low-water mark. */
  bufferLowWaterBytes: number
  /** A receiver that doesn't get from the high-water to the low-water mark this fast is dropped. */
  stallTimeoutMs: number
  /** Past these the receiver is disconnected. */
  phoneBufferCapBytes: number
  hostBufferCapBytes: number
  /** All send queues together; past it the largest queues are dropped first. */
  maxQueuedBytes: number
  /** How often the relay adds up its send queues against `maxQueuedBytes`. */
  queueSweepMs: number
  connectionsPerIpPerMinute: number
  /** Open sockets per IP, authenticated or not. */
  maxConnectionsPerIp: number
  /** Offers whose `exp` is further out than this are clamped to it. */
  maxOfferTtlSeconds: number
  /** Most IDs one `watch` may carry. */
  maxWatch: number
  /** Pushes one connection may have awaiting a result; more are answered `rate`. */
  maxPushesInFlight: number
  /** Pending pairs one device may be part of at once. */
  maxPendingPerDevice: number
  /** Authorized pairs one device may be part of. */
  maxPairsPerDevice: number
  /** New pairs that the devices on one IP may authorize per hour. */
  newPairsPerIpPerHour: number
  /** Devices whose `lastSeen` the relay remembers; the oldest are forgotten first. */
  maxLastSeen: number
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxFrameBytes: RELAY_MAX_FRAME_BYTES,
  helloTimeoutMs: RELAY_HELLO_TIMEOUT_MS,
  idleTimeoutMs: RELAY_IDLE_TIMEOUT_MS,
  ratePerSecond: RELAY_RATE_PER_SECOND,
  rateBurst: RELAY_RATE_BURST,
  rateStrikeWindowMs: 10_000,
  hostRatePerSecond: RELAY_HOST_RATE_PER_SECOND,
  hostRateBurst: RELAY_HOST_RATE_BURST,
  hostBytesPerSecond: RELAY_HOST_BYTES_PER_SECOND,
  hostBytesBurst: RELAY_HOST_BYTES_BURST,
  ipBytesPerSecond: RELAY_IP_BYTES_PER_SECOND,
  ipBytesBurst: RELAY_IP_BYTES_BURST,
  pushRatePerSecond: RELAY_PUSH_RATE_PER_SECOND,
  pushRateBurst: RELAY_PUSH_RATE_BURST,
  bufferHighWaterBytes: RELAY_BUFFER_HIGH_WATER_BYTES,
  bufferLowWaterBytes: RELAY_BUFFER_LOW_WATER_BYTES,
  stallTimeoutMs: RELAY_STALL_TIMEOUT_MS,
  phoneBufferCapBytes: RELAY_PHONE_BUFFER_CAP_BYTES,
  hostBufferCapBytes: RELAY_HOST_BUFFER_CAP_BYTES,
  maxQueuedBytes: 512 * 1024 * 1024,
  queueSweepMs: 1000,
  connectionsPerIpPerMinute: RELAY_CONNECTIONS_PER_IP_PER_MINUTE,
  maxConnectionsPerIp: RELAY_MAX_CONNECTIONS_PER_IP,
  maxOfferTtlSeconds: 900,
  maxWatch: 256,
  maxPushesInFlight: 64,
  maxPendingPerDevice: RELAY_MAX_PENDING_PER_DEVICE,
  maxPairsPerDevice: RELAY_MAX_PAIRS_PER_DEVICE,
  newPairsPerIpPerHour: RELAY_NEW_PAIRS_PER_IP_PER_HOUR,
  maxLastSeen: 100_000
}

export interface Clock {
  /** Unix ms. */
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/** What the core needs from a socket. */
export interface Connection {
  send(text: string): void
  sendBinary(data: Uint8Array): void
  close(code: number, reason: string): void
  /** Drops the socket at once, with whatever it had queued and no close frame. */
  terminate(): void
  /** Bytes queued for this socket that the OS hasn't taken yet. */
  bufferedBytes(): number
  /** Calls `fn` once, when that queue is at or below `bytes`. A later call replaces it. */
  onBufferBelow(bytes: number, fn: () => void): void
  /** The socket is destroyed once its queue grows past `bytes`. */
  setBufferCap(bytes: number): void
  /** Stops delivering this socket's messages (and reading it) until `resume`. */
  pause(): void
  resume(): void
}

/** What the socket layer calls on the core for one connection. */
export interface ConnectionHandle {
  message(data: Uint8Array, isBinary: boolean): void
  /** The socket is gone (for whatever reason). Idempotent. */
  closed(): void
}

/**
 * Where a desktop's `push` goes (§7.2): the in-process gateway, or the upstream one over
 * HTTPS. Resolves with the result to send back; it should not reject (a rejection is
 * reported as `error`).
 */
export interface PushForwarder {
  push(cap: string, data: string): Promise<PushResult>
}

export interface RelayOptions {
  store: RelayStore
  clock?: Clock
  limits?: Partial<RelayLimits>
  logger?: Logger
  /** Absent: every `push` is answered `unavailable`. */
  push?: PushForwarder
}

export interface RelayStats {
  connections: number
  online: number
  offers: number
  pending: number
  /** Connections whose reading is paused (throttled, or held back by a full receiver). */
  paused: number
  /** Bytes queued for all sockets that the OS hasn't taken yet. */
  queued: number
  /** Connections dropped for not reading (stalled, or over the relay-wide queue ceiling). */
  dropped: number
}

export interface Relay {
  readonly limits: RelayLimits
  /** Per-IP connection budget and cap; call before accepting a socket. */
  admit(ip: string): boolean
  open(conn: Connection, info: { ip: string }): ConnectionHandle
  stats(): RelayStats
  /** Closes every connection with 1001 and stops all timers. */
  shutdown(): void
}

/** Why a connection's reading is paused: its own budget, or a receiver it fills up. */
type PauseReason = 'rate' | Client

/** What the relay keeps per client IP while it has sockets, or budgets still recovering. */
interface IpState {
  connections: number
  /** Payload bytes from every connection of this IP. */
  bytes: TokenBucket
  /** New pairs authorized from this IP. */
  newPairs: TokenBucket
}

interface Client {
  readonly conn: Connection
  readonly ip: string
  readonly ipState: IpState
  readonly nonce: string
  /** Messages. Phones (and everyone before hello) `take`; desktops and servers `spend`. */
  bucket: TokenBucket
  /** Payload bytes; desktops and servers only. */
  bytes: TokenBucket | null
  readonly pushes: TokenBucket
  id: string | null
  role: Role | null
  pub: string | null
  /** Receives frames as binary messages (hello `binary`). */
  binary: boolean
  closed: boolean
  helloTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  throttleTimer: ReturnType<typeof setTimeout> | null
  /** Armed while the send queue is over the high-water mark and hasn't drained since. */
  stallTimer: ReturnType<typeof setTimeout> | null
  rateStrikeAt: number | null
  /** Hosts whose presence this client asked for (`watch`), with the role each holds. */
  watched: Map<string, Role>
  /** Desktops and servers: pushes awaiting a result. */
  pushesInFlight: number
  pausedBy: Set<PauseReason>
  /** Senders paused because this client's queue went over the high-water mark. */
  blockedSenders: Set<Client>
}

interface Offer {
  tokenHash: Uint8Array
  expMs: number
  ownerRole: Role
}

/**
 * A pair between two devices as the relay routes it, authorized (from the store) or
 * pending: the owner made the offer and is the one to `authorize`.
 */
interface Link {
  ownerId: string
  ownerRole: Role
  peerId: string
  peerRole: Role
}

interface Pending extends Link {
  peerPub: string
  expMs: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * §3.8: in every pair the higher rank is the host. The host gets the other side's
 * presence by itself; the other side asks for the host's with `watch`.
 */
const HOST_RANK: Record<Role, number> = { phone: 0, desktop: 1, server: 2 }

/** §3.8: phone↔desktop, phone↔server and desktop↔server may pair; two of a kind may not. */
function mayPair(a: Role, b: Role): boolean {
  return a !== b
}

/** Roles that offer, authorize, revoke and push. */
function isHost(role: Role | null): boolean {
  return role === 'desktop' || role === 'server'
}

function pairLink(pair: Pair): Link {
  return { ownerId: pair.ownerId, ownerRole: pair.ownerRole, peerId: pair.peerId, peerRole: pair.kind }
}

function roleIn(link: Link, id: string): Role {
  return link.ownerId === id ? link.ownerRole : link.peerRole
}

function otherSide(link: Link, id: string): { id: string; role: Role } {
  return link.ownerId === id ? { id: link.peerId, role: link.peerRole } : { id: link.ownerId, role: link.ownerRole }
}

const decoder = new TextDecoder()

export function createRelay(options: RelayOptions): Relay {
  const store = options.store
  const clock = options.clock ?? systemClock
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits }
  // A low-water mark above the high-water mark would release (and disarm) at once.
  limits.bufferLowWaterBytes = Math.min(limits.bufferLowWaterBytes, limits.bufferHighWaterBytes)
  const log = options.logger ?? silentLogger
  const forwarder = options.push ?? null
  const ipLimiter = new IpLimiter(limits.connectionsPerIpPerMinute)

  const clients = new Set<Client>()
  /** Authenticated connections by device ID. */
  const online = new Map<string, Client>()
  /** Live offer per offering device (desktop or server). */
  const offers = new Map<string, Offer>()
  /** Pending peers, keyed `ownerId:peerId`. Survive a reconnect of either side until `expMs`. */
  const pending = new Map<string, Pending>()
  /** The same pending pairs, by each device in them (both sides). */
  const pendingOf = new Map<string, Set<Pending>>()
  /** When each device last disconnected (unix ms), oldest first. Memory only, capped. */
  const lastSeen = new Map<string, number>()
  const perIp = new Map<string, IpState>()
  let dropped = 0

  const pruneTimer = setInterval(() => prune(clock.now()), 60_000)
  pruneTimer.unref?.()
  const sweepTimer = setInterval(sweepQueues, limits.queueSweepMs)
  sweepTimer.unref?.()

  const pendingKey = (ownerId: string, peerId: string): string => `${ownerId}:${peerId}`

  function prune(now: number): void {
    ipLimiter.prune(now)
    for (const [ip, state] of perIp) {
      if (state.connections === 0 && state.bytes.isFull(now) && state.newPairs.isFull(now)) perIp.delete(ip)
    }
  }

  function ipStateFor(ip: string): IpState {
    let state = perIp.get(ip)
    if (!state) {
      const now = clock.now()
      state = {
        connections: 0,
        bytes: new TokenBucket(limits.ipBytesPerSecond, limits.ipBytesBurst, now),
        newPairs: new TokenBucket(limits.newPairsPerIpPerHour / 3600, limits.newPairsPerIpPerHour, now)
      }
      perIp.set(ip, state)
    }
    return state
  }

  function rememberSeen(id: string, at: number): void {
    lastSeen.delete(id)
    lastSeen.set(id, at)
    if (lastSeen.size > limits.maxLastSeen) lastSeen.delete(lastSeen.keys().next().value!)
  }

  function send(client: Client, message: ServerMessage): void {
    if (client.closed) return
    client.conn.send(encodeRelayMessage(message))
    watchQueue(client)
  }

  function sendError(client: Client, code: RelayErrorCode, message?: string, to?: string): void {
    const msg: ServerMessage = { t: 'error', code }
    if (message !== undefined) msg.message = message
    if (to !== undefined) msg.to = to
    send(client, msg)
  }

  function onlineAs(id: string, role: Role): Client | null {
    const client = online.get(id)
    return client && client.role === role && !client.closed ? client : null
  }

  function livePending(ownerId: string, peerId: string): Pending | null {
    const p = pending.get(pendingKey(ownerId, peerId))
    return p && p.expMs > clock.now() ? p : null
  }

  function pendingCount(id: string): number {
    return pendingOf.get(id)?.size ?? 0
  }

  function addPending(p: Pending): void {
    removePending(p.ownerId, p.peerId)
    pending.set(pendingKey(p.ownerId, p.peerId), p)
    for (const id of [p.ownerId, p.peerId]) {
      let set = pendingOf.get(id)
      if (!set) pendingOf.set(id, (set = new Set()))
      set.add(p)
    }
  }

  /** Removes the pending pair (owner, peer), if any. Returns whether there was one. */
  function removePending(ownerId: string, peerId: string): boolean {
    const key = pendingKey(ownerId, peerId)
    const p = pending.get(key)
    if (!p) return false
    clearTimeout(p.timer)
    pending.delete(key)
    for (const id of [p.ownerId, p.peerId]) {
      const set = pendingOf.get(id)
      set?.delete(p)
      if (set?.size === 0) pendingOf.delete(id)
    }
    return true
  }

  /** The authorized or pending pair between `a` and `b`, in whichever orientation. */
  function linkBetween(a: string, b: string): Link | null {
    const pair = store.findPair(a, b)
    if (pair) return pairLink(pair)
    return livePending(a, b) ?? livePending(b, a)
  }

  /** Every authorized pair, then every pending one, that `id` is part of. */
  function linksOf(id: string): Link[] {
    const links: Link[] = store.pairsOf(id).map(pairLink)
    const now = clock.now()
    for (const p of pendingOf.get(id) ?? []) if (p.expMs > now) links.push(p)
    return links
  }

  function peerMessage(id: string, state: PeerState, seen?: number): ServerMessage {
    const msg: ServerMessage = { t: 'peer', id, state }
    if (seen !== undefined) msg.lastSeen = seen
    return msg
  }

  /**
   * Tells everyone entitled to this device's presence that it came online or went
   * offline: the hosts it is paired with (or pending with), and whoever watches it.
   */
  function announce(client: Client, state: 'online' | 'offline'): void {
    const id = client.id!
    const role = client.role!
    const msg = peerMessage(id, state, state === 'offline' ? lastSeen.get(id) : undefined)
    const targets = new Set<Client>()
    for (const link of linksOf(id)) {
      if (roleIn(link, id) !== role) continue
      const other = otherSide(link, id)
      if (HOST_RANK[other.role] <= HOST_RANK[role]) continue
      const host = onlineAs(other.id, other.role)
      if (host) targets.add(host)
    }
    for (const watcher of online.values()) {
      if (watcher.watched.get(id) === role) targets.add(watcher)
    }
    for (const target of targets) send(target, msg)
  }

  /** On a host's `ready`: where the devices it hosts (authorized or pending) stand right now. */
  function sendRoster(client: Client): void {
    const id = client.id!
    const role = client.role!
    const seen = new Set<string>()
    for (const link of linksOf(id)) {
      if (roleIn(link, id) !== role) continue
      const other = otherSide(link, id)
      if (HOST_RANK[other.role] >= HOST_RANK[role] || seen.has(other.id)) continue
      seen.add(other.id)
      if (onlineAs(other.id, other.role)) send(client, peerMessage(other.id, 'online'))
      else if (lastSeen.has(other.id)) send(client, peerMessage(other.id, 'offline', lastSeen.get(other.id)))
    }
  }

  /** A pair just became pending after both sides were online: tell its host. */
  function announceLinked(link: Link): void {
    const owner = onlineAs(link.ownerId, link.ownerRole)
    const peer = onlineAs(link.peerId, link.peerRole)
    if (!owner || !peer) return
    const ownerHosts = HOST_RANK[link.ownerRole] > HOST_RANK[link.peerRole]
    send(ownerHosts ? owner : peer, peerMessage(ownerHosts ? link.peerId : link.ownerId, 'online'))
  }

  // ---- reading: pause, throttle, backpressure, stalls (§3.10) -------------------------

  function pauseFor(client: Client, reason: PauseReason): void {
    if (client.closed || client.pausedBy.has(reason)) return
    client.pausedBy.add(reason)
    if (client.pausedBy.size === 1) client.conn.pause()
  }

  function resumeFor(client: Client, reason: PauseReason): void {
    if (!client.pausedBy.delete(reason) || client.pausedBy.size > 0 || client.closed) return
    client.idleTimer?.refresh()
    client.conn.resume()
  }

  /** How long until every budget this client spends from is out of debt. */
  function budgetWait(client: Client, now: number): number {
    return Math.max(client.bucket.waitMs(now), client.bytes?.waitMs(now) ?? 0, client.ipState.bytes.waitMs(now))
  }

  /** Over budget: stop reading until every bucket it spends from is out of debt. */
  function throttle(client: Client, waitMs: number): void {
    if (client.throttleTimer || client.closed) return
    pauseFor(client, 'rate')
    const wake = (): void => {
      client.throttleTimer = null
      if (client.closed) return
      const again = budgetWait(client, clock.now())
      if (again > 0) {
        client.throttleTimer = setTimeout(wake, again)
        client.throttleTimer.unref?.()
        return
      }
      resumeFor(client, 'rate')
    }
    client.throttleTimer = setTimeout(wake, waitMs)
    client.throttleTimer.unref?.()
  }

  /**
   * After anything was queued for `client`: once its queue is over the high-water mark,
   * it has `stallTimeoutMs` to drain to the low-water mark, or it is dropped.
   */
  function watchQueue(client: Client): void {
    if (client.stallTimer || client.closed || client.conn.bufferedBytes() <= limits.bufferHighWaterBytes) return
    client.stallTimer = setTimeout(() => {
      client.stallTimer = null
      kill(client, 'stalled')
    }, limits.stallTimeoutMs)
    client.stallTimer.unref?.()
    client.conn.onBufferBelow(limits.bufferLowWaterBytes, () => drained(client))
  }

  function drained(client: Client): void {
    if (client.stallTimer) clearTimeout(client.stallTimer)
    client.stallTimer = null
    releaseSenders(client)
  }

  /** After a frame reached `receiver`: hold its sender back while the receiver's queue is too long. */
  function applyBackpressure(sender: Client, receiver: Client): void {
    const queued = receiver.conn.bufferedBytes()
    if (queued <= limits.bufferHighWaterBytes || receiver.closed) return
    if (!receiver.blockedSenders.has(sender)) {
      receiver.blockedSenders.add(sender)
      pauseFor(sender, receiver)
      log.debug('backpressure', { from: sender.id, to: receiver.id, queued })
    }
  }

  function releaseSenders(receiver: Client): void {
    if (receiver.blockedSenders.size === 0) return
    const senders = [...receiver.blockedSenders]
    receiver.blockedSenders.clear()
    for (const sender of senders) resumeFor(sender, receiver)
  }

  /**
   * Drops a connection that isn't reading what we queue for it. A close frame would
   * only wait behind that queue, so the socket goes at once; the client sees 1006.
   */
  function kill(client: Client, reason: 'stalled' | 'queue-ceiling'): void {
    if (client.closed) return
    dropped++
    log.info('dropped', { id: client.id, role: client.role, ip: client.ip, reason, queued: client.conn.bufferedBytes() })
    cleanup(client)
    client.conn.terminate()
  }

  /** Relay-wide ceiling on queued bytes: drop the largest queues until back under it. */
  function sweepQueues(): void {
    let total = 0
    const queues: Array<{ client: Client; queued: number }> = []
    for (const client of clients) {
      const queued = client.conn.bufferedBytes()
      if (queued === 0) continue
      total += queued
      queues.push({ client, queued })
    }
    if (total <= limits.maxQueuedBytes) return
    queues.sort((a, b) => b.queued - a.queued)
    for (const { client, queued } of queues) {
      if (total <= limits.maxQueuedBytes) break
      kill(client, 'queue-ceiling')
      total -= queued
    }
  }

  // ---- lifecycle ------------------------------------------------------------------

  function clearTimers(client: Client): void {
    for (const timer of [client.helloTimer, client.idleTimer, client.throttleTimer, client.stallTimer]) {
      if (timer) clearTimeout(timer)
    }
    client.helloTimer = null
    client.idleTimer = null
    client.throttleTimer = null
    client.stallTimer = null
  }

  /** Forgets a connection. Presence and offers go with it unless a newer socket took over the ID. */
  function cleanup(client: Client): void {
    if (!clients.has(client)) return
    clients.delete(client)
    client.closed = true
    client.ipState.connections--
    clearTimers(client)
    releaseSenders(client)
    for (const reason of client.pausedBy) if (reason !== 'rate') reason.blockedSenders.delete(client)
    client.pausedBy.clear()
    const id = client.id
    if (id === null || online.get(id) !== client) return
    online.delete(id)
    rememberSeen(id, clock.now())
    offers.delete(id)
    announce(client, 'offline')
    log.info('disconnected', { id, role: client.role })
  }

  function drop(client: Client, code: number, reason: string): void {
    if (client.closed) return
    cleanup(client)
    client.conn.close(code, reason)
  }

  function authFail(client: Client, message: string, code: RelayErrorCode = 'auth'): void {
    log.info('auth-failed', { ip: client.ip, reason: message })
    sendError(client, code, message)
    drop(client, RelayCloseCode.Auth, 'auth failed')
  }

  function onHello(client: Client, text: string): void {
    let msg: ClientMessage
    try {
      msg = parseClientMessage(text)
    } catch (err) {
      if (err instanceof UnsupportedMessageError && err.role !== undefined) return authFail(client, `unknown role ${err.role}`, 'unsupported')
      if (!(err instanceof ProtocolError)) throw err
      return authFail(client, 'malformed hello')
    }
    if (msg.t !== 'hello') return authFail(client, 'expected hello')
    const id = verifyHello(msg, client.nonce)
    if (id === null) return authFail(client, 'bad signature')
    if (client.helloTimer) clearTimeout(client.helloTimer)
    client.helloTimer = null
    client.id = id
    client.role = msg.role
    client.pub = msg.pub
    client.binary = msg.binary === true
    if (isHost(msg.role)) {
      const now = clock.now()
      client.bucket = new TokenBucket(limits.hostRatePerSecond, limits.hostRateBurst, now)
      client.bytes = new TokenBucket(limits.hostBytesPerSecond, limits.hostBytesBurst, now)
    }
    client.conn.setBufferCap(msg.role === 'phone' ? limits.phoneBufferCapBytes : limits.hostBufferCapBytes)

    const previous = online.get(id)
    online.set(id, client)
    if (previous) {
      offers.delete(id)
      drop(previous, RelayCloseCode.Replaced, 'replaced by a newer connection')
      log.info('replaced', { id, role: msg.role })
    }
    const ready: ReadyMessage = { t: 'ready', id }
    if (client.binary) ready.binary = true
    send(client, ready)
    log.info('connected', { id, role: msg.role, ip: client.ip, binary: client.binary })

    if (msg.pair) attachPending(client, msg.pair.to, msg.pair.token)
    sendRoster(client)
    announce(client, 'online')
  }

  /**
   * `client` presented `token` for `ownerId`'s offer (hello `pair`, or the `pair`
   * message): make it pending under that offer. Returns whether a new pending pair exists.
   * Refusals log at debug only: a client can send them as fast as its budget allows.
   */
  function attachPending(client: Client, ownerId: string, token: string): boolean {
    const peerId = client.id!
    const peerRole = client.role!
    if (ownerId === peerId) {
      sendError(client, 'forbidden', 'a device cannot pair with itself', ownerId)
      return false
    }
    if (store.findPair(ownerId, peerId)) return false
    const key = pendingKey(ownerId, peerId)
    const existing = livePending(ownerId, peerId)
    if (existing && existing.peerPub === client.pub && existing.peerRole === peerRole) return false
    const offer = offers.get(ownerId)
    const now = clock.now()
    const presented = sha256(b64uDecode(token))
    if (!offer || offer.expMs <= now || !constantTimeEqual(presented, offer.tokenHash)) {
      log.debug('pair-refused', { peer: peerId, owner: ownerId })
      sendError(client, 'forbidden', 'no live pairing offer matches this token', ownerId)
      return false
    }
    if (!mayPair(offer.ownerRole, peerRole)) {
      log.debug('pair-refused', { peer: peerId, owner: ownerId, roles: `${peerRole}/${offer.ownerRole}` })
      sendError(client, 'forbidden', `a ${peerRole} cannot pair with a ${offer.ownerRole}`, ownerId)
      return false
    }
    if (!pending.has(key) && (pendingCount(ownerId) >= limits.maxPendingPerDevice || pendingCount(peerId) >= limits.maxPendingPerDevice)) {
      log.debug('pair-refused', { peer: peerId, owner: ownerId, reason: 'too many pending' })
      sendError(client, 'forbidden', 'too many pending pairs', ownerId)
      return false
    }
    // One use: the next device needs the owner's next offer.
    offers.delete(ownerId)
    const timer = setTimeout(() => lapse(key), Math.max(0, offer.expMs - now))
    timer.unref?.()
    addPending({ ownerId, ownerRole: offer.ownerRole, peerId, peerRole, peerPub: client.pub!, expMs: offer.expMs, timer })
    log.debug('pending', { peer: peerId, owner: ownerId, role: peerRole })
    return true
  }

  /** A pending peer's offer lifetime ran out without `authorize`. */
  function lapse(key: string): void {
    const p = pending.get(key)
    if (!p) return
    removePending(p.ownerId, p.peerId)
    log.debug('pending-expired', { peer: p.peerId, owner: p.ownerId })
    const peer = onlineAs(p.peerId, p.peerRole)
    if (!peer) return
    const owner = onlineAs(p.ownerId, p.ownerRole)
    if (owner) {
      // The host was told the other side is online; it isn't reachable any more.
      const ownerHosts = HOST_RANK[p.ownerRole] > HOST_RANK[p.peerRole]
      send(ownerHosts ? owner : peer, peerMessage(ownerHosts ? p.peerId : p.ownerId, 'offline', clock.now()))
    }
    sendError(peer, 'forbidden', 'pairing window expired', p.ownerId)
    // A phone that is also paired elsewhere keeps its socket for those hosts.
    if (p.peerRole === 'phone' && linksOf(p.peerId).length === 0) {
      drop(peer, RelayCloseCode.PairingExpired, 'pairing window expired')
    }
  }

  function onOffer(client: Client, msg: OfferMessage): void {
    const now = clock.now()
    const expMs = Math.min(msg.exp * 1000, now + limits.maxOfferTtlSeconds * 1000)
    offers.set(client.id!, { tokenHash: b64uDecode(msg.tokenHash), expMs, ownerRole: client.role! })
    log.debug('offer', { owner: client.id, ttlMs: expMs - now })
  }

  function onPair(client: Client, msg: PairMessage): void {
    if (!attachPending(client, msg.to, msg.token)) return
    announceLinked(pending.get(pendingKey(msg.to, client.id!))!)
  }

  function onAuthorize(client: Client, msg: AuthorizeMessage): void {
    const ownerId = client.id!
    const peerId = pairTarget(msg)
    if (deviceId(b64uDecode(msg.pub)) !== peerId) return sendError(client, 'bad-request', 'pub does not match the peer ID', peerId)
    const p = livePending(ownerId, peerId)
    const pendingHere = p && p.ownerRole === client.role ? p : null
    const stored = store.getPair(ownerId, peerId)
    const existing = stored && stored.ownerRole === client.role ? stored : null
    const knownPub = pendingHere?.peerPub ?? existing?.peerPub
    const kind = pendingHere?.peerRole ?? existing?.kind
    if (knownPub === undefined || kind === undefined) return sendError(client, 'forbidden', 'peer is neither pending nor authorized', peerId)
    if (knownPub !== msg.pub) return sendError(client, 'forbidden', 'pub does not match the authenticated peer', peerId)
    if (existing && existing.kind === kind && existing.ownerPub === client.pub) {
      // Already stored as is: repeating `authorize` costs no write.
      if (pendingHere) removePending(ownerId, peerId)
      return
    }
    if (!existing) {
      if (store.countPairs(ownerId) >= limits.maxPairsPerDevice || store.countPairs(peerId) >= limits.maxPairsPerDevice) {
        return sendError(client, 'forbidden', 'too many pairs', peerId)
      }
      if (!client.ipState.newPairs.take(clock.now())) return sendError(client, 'rate', 'too many new pairs from this address; try again later', peerId)
    }
    store.putPair({
      ownerId,
      ownerRole: client.role!,
      ownerPub: client.pub!,
      peerId,
      kind,
      peerPub: msg.pub,
      createdAt: existing?.createdAt ?? clock.now()
    })
    removePending(ownerId, peerId)
    removePending(peerId, ownerId)
    log.info('authorized', { owner: ownerId, peer: peerId, kind })
  }

  function onRevoke(client: Client, msg: RevokeMessage): void {
    const selfId = client.id!
    const otherId = pairTarget(msg)
    const pair = store.findPair(selfId, otherId)
    const p = pending.get(pendingKey(selfId, otherId)) ?? pending.get(pendingKey(otherId, selfId))
    const link: Link | null = pair ? pairLink(pair) : (p ?? null)
    if (!link) return
    if (pair) store.deletePair(selfId, otherId)
    removePending(selfId, otherId)
    removePending(otherId, selfId)
    if (pair) log.info('revoked', { by: selfId, peer: otherId })
    else log.debug('pending-cancelled', { by: selfId, peer: otherId })
    client.watched.delete(otherId)
    const other = onlineAs(otherId, roleIn(link, otherId))
    if (other) {
      other.watched.delete(selfId)
      send(other, peerMessage(selfId, 'revoked'))
    }
  }

  function onWatch(client: Client, msg: WatchMessage): void {
    if (msg.desktops.length > limits.maxWatch) return sendError(client, 'bad-request', `watch at most ${limits.maxWatch} desktops`)
    const selfId = client.id!
    const role = client.role!
    // Hosts pay for each ID: one watch can produce as many replies as it names.
    if (client.bytes) {
      const wait = client.bucket.spend(msg.desktops.length, clock.now())
      if (wait > 0) throttle(client, wait)
    }
    // One indexed query for the watcher's pairs, instead of one per ID.
    const hosts = new Map<string, Role>()
    for (const pair of store.pairsOf(selfId)) {
      const link = pairLink(pair)
      if (roleIn(link, selfId) !== role) continue
      const other = otherSide(link, selfId)
      if (HOST_RANK[other.role] > HOST_RANK[role]) hosts.set(other.id, other.role)
    }
    const watched = new Map<string, Role>()
    for (const target of msg.desktops) {
      const targetRole = hosts.get(target)
      if (targetRole !== undefined) watched.set(target, targetRole)
    }
    client.watched = watched
    for (const [target, targetRole] of watched) {
      if (onlineAs(target, targetRole)) send(client, peerMessage(target, 'online'))
      else send(client, peerMessage(target, 'offline', lastSeen.get(target)))
    }
  }

  /**
   * §3.4/§3.9: one frame from `sender` to `to`, as raw `envelope` bytes (binary) or as
   * `b64` (JSON). The receiver gets it in the format it asked for.
   */
  function route(sender: Client, to: string, envelope: Uint8Array | null, b64: string | null): void {
    const senderId = sender.id!
    const link = to === senderId ? null : linkBetween(senderId, to)
    if (!link || roleIn(link, senderId) !== sender.role) return sendError(sender, 'forbidden', 'not paired', to)
    const receiver = onlineAs(to, roleIn(link, to))
    if (!receiver) return sendError(sender, 'offline', undefined, to)
    if (receiver.binary) {
      receiver.conn.sendBinary(encodeRelayBinaryFrame(senderId, envelope ?? b64uDecode(b64!)))
      watchQueue(receiver)
    } else {
      send(receiver, { t: 'frame', from: senderId, data: b64 ?? b64uEncode(envelope!) })
    }
    applyBackpressure(sender, receiver)
  }

  function onBinary(client: Client, data: Uint8Array): void {
    let frame: { peer: string; envelope: Uint8Array }
    try {
      frame = decodeRelayBinaryFrame(data)
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      return sendError(client, 'bad-request', err.message)
    }
    route(client, frame.peer, frame.envelope, null)
  }

  function onPush(client: Client, msg: PushMessage): void {
    const reply = (result: PushResult): void => send(client, { t: 'pushed', id: msg.id, result })
    // Each push may cost an HTTPS call upstream: keep it at the budget desktops always had.
    if (!client.pushes.take(clock.now())) return reply('rate')
    if (!forwarder) return reply('unavailable')
    if (client.pushesInFlight >= limits.maxPushesInFlight) return reply('rate')
    client.pushesInFlight++
    forwarder
      .push(msg.cap, msg.data)
      .catch((): PushResult => 'error')
      .then((result) => {
        client.pushesInFlight--
        log.debug('pushed', { from: client.id, result })
        reply(result)
      })
  }

  function onMessage(client: Client, text: string): void {
    let msg: ClientMessage
    try {
      msg = parseClientMessage(text)
    } catch (err) {
      if (err instanceof UnsupportedMessageError) return sendError(client, 'unsupported', err.message)
      if (!(err instanceof ProtocolError)) throw err
      return sendError(client, 'bad-request', err.message)
    }
    const role = client.role
    switch (msg.t) {
      case 'frame':
        return route(client, msg.to, null, msg.data)
      case 'ping':
        return send(client, { t: 'pong' })
      case 'pong':
        return
      case 'hello':
        return sendError(client, 'bad-request', 'already authenticated')
      case 'pair':
        return onPair(client, msg)
      case 'offer':
        return isHost(role) ? onOffer(client, msg) : sendError(client, 'forbidden', 'desktops and servers only')
      case 'authorize':
        return isHost(role) ? onAuthorize(client, msg) : sendError(client, 'forbidden', 'desktops and servers only')
      case 'revoke':
        return isHost(role) ? onRevoke(client, msg) : sendError(client, 'forbidden', 'desktops and servers only')
      case 'push':
        return isHost(role) ? onPush(client, msg) : sendError(client, 'forbidden', 'desktops and servers only')
      case 'watch':
        return role === 'phone' || role === 'desktop' ? onWatch(client, msg) : sendError(client, 'forbidden', 'phones and desktops only')
    }
  }

  function receive(client: Client, data: Uint8Array, isBinary: boolean): void {
    if (client.closed) return
    if (data.length > limits.maxFrameBytes) return drop(client, RelayCloseCode.TooBig, 'message too big')
    const now = clock.now()
    // Every connection of an IP shares one byte budget, throttled (§3.10).
    let wait = client.ipState.bytes.spend(data.length, now)
    if (client.bytes) {
      // Desktops and servers: throttled (reading paused), never refused.
      wait = Math.max(wait, client.bucket.spend(1, now), client.bytes.spend(data.length, now))
    } else if (!client.bucket.take(now)) {
      if (client.rateStrikeAt !== null && now - client.rateStrikeAt < limits.rateStrikeWindowMs) {
        log.info('rate-closed', { id: client.id, ip: client.ip })
        sendError(client, 'rate', 'too many messages')
        return drop(client, RelayCloseCode.Rate, 'rate limit')
      }
      client.rateStrikeAt = now
      return sendError(client, 'rate', 'too many messages; slow down')
    }
    if (wait > 0) throttle(client, wait)
    client.idleTimer?.refresh()
    if (client.id === null) {
      if (isBinary) return authFail(client, 'expected hello')
      return onHello(client, decoder.decode(data))
    }
    if (isBinary) return onBinary(client, data)
    onMessage(client, decoder.decode(data))
  }

  return {
    limits,
    admit(ip) {
      // A refused attempt still counts toward the per-minute budget.
      const ok = ipLimiter.admit(ip, clock.now())
      const open = perIp.get(ip)?.connections ?? 0
      if (ok && open < limits.maxConnectionsPerIp) return true
      // Debug only: a refused client can retry as fast as it opens TCP connections.
      log.debug('ip-limited', { ip, open })
      return false
    },
    open(conn, info) {
      const now = clock.now()
      const ipState = ipStateFor(info.ip)
      ipState.connections++
      const client: Client = {
        conn,
        ip: info.ip,
        ipState,
        nonce: b64uEncode(randomBytes(32)),
        bucket: new TokenBucket(limits.ratePerSecond, limits.rateBurst, now),
        bytes: null,
        pushes: new TokenBucket(limits.pushRatePerSecond, limits.pushRateBurst, now),
        id: null,
        role: null,
        pub: null,
        binary: false,
        closed: false,
        helloTimer: null,
        idleTimer: null,
        throttleTimer: null,
        stallTimer: null,
        rateStrikeAt: null,
        watched: new Map(),
        pushesInFlight: 0,
        pausedBy: new Set(),
        blockedSenders: new Set()
      }
      clients.add(client)
      client.helloTimer = setTimeout(() => {
        log.info('hello-timeout', { ip: client.ip })
        drop(client, RelayCloseCode.HelloTimeout, 'hello timeout')
      }, limits.helloTimeoutMs)
      client.idleTimer = setTimeout(() => {
        // We aren't reading a paused socket, so its silence isn't the client's. Pauses are
        // bounded: by the budgets, and by the stall timeout of whoever holds it back.
        if (client.pausedBy.size > 0) return client.idleTimer?.refresh()
        log.info('idle-timeout', { id: client.id, ip: client.ip })
        drop(client, RelayCloseCode.GoingAway, 'idle timeout')
      }, limits.idleTimeoutMs)
      send(client, { t: 'challenge', nonce: client.nonce })
      return {
        message: (data, isBinary) => receive(client, data, isBinary),
        closed: () => cleanup(client)
      }
    },
    stats() {
      let paused = 0
      let queued = 0
      for (const client of clients) {
        if (client.pausedBy.size > 0) paused++
        queued += client.conn.bufferedBytes()
      }
      return { connections: clients.size, online: online.size, offers: offers.size, pending: pending.size, paused, queued, dropped }
    },
    shutdown() {
      clearInterval(pruneTimer)
      clearInterval(sweepTimer)
      for (const p of [...pending.values()]) removePending(p.ownerId, p.peerId)
      for (const client of [...clients]) drop(client, RelayCloseCode.GoingAway, 'server shutting down')
    }
  }
}

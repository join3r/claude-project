import {
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_PATH,
  RELAY_PING_INTERVAL_MS,
  RelayCloseCode,
  buildHello,
  decodeRelayBinaryFrame,
  encodeRelayBinaryFrame,
  encodeRelayMessage,
  parseServerMessage
} from '../../../protocol/ts/index.ts'
import type { ClientMessage, KeyPair, Role, ServerMessage } from '../../../protocol/ts/index.ts'
import type { RelayServerMessage, RelayTransport, RelayTransportState } from './mobile-service'

/** The slice of the WHATWG WebSocket the client uses (Node ≥ 22's global, or a fake). */
export interface WebSocketLike {
  readonly readyState: number
  /** Bytes queued by `send` that the OS hasn't taken yet; fakes may leave it out (0). */
  readonly bufferedAmount?: number
  /** Set to `'arraybuffer'` when binary frames were asked for. */
  binaryType?: string
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

const OPEN = 1

export interface RelayClientTimers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface RelayClientOptions {
  /** Our Ed25519 keypair (read lazily: the identity loads on first use). */
  ed25519: () => KeyPair
  /** The role we sign in as (SPEC.md §3.8). Defaults to `desktop`. */
  role?: Exclude<Role, 'phone'>
  /**
   * Ask for binary frames (SPEC.md §3.9): the relay then delivers every frame as a
   * binary message, phones' included, and `ready` says whether it agreed.
   */
  binary?: boolean
  /** Our device ID, to check the relay's `ready`. */
  deviceId: () => string
  createSocket?: (url: string) => WebSocketLike
  log?: (message: string) => void
  timers?: RelayClientTimers
  /** Reconnect backoff bounds (plan: 1 s → 30 s). */
  minBackoffMs?: number
  maxBackoffMs?: number
  /** How long challenge → ready may take before the attempt is abandoned. */
  authTimeoutMs?: number
  pingIntervalMs?: number
  idleTimeoutMs?: number
}

const realTimers: RelayClientTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
}

function defaultSocket(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (!Ctor) throw new Error('WebSocket is not available in this runtime')
  return new Ctor(url)
}

/** How often a drain waiter checks the socket's `bufferedAmount` (Node's WebSocket has no drain event). */
const DRAIN_POLL_MS = 10
/**
 * A socket the relay stopped reading (budget, a slow receiver; SPEC.md §3.10) gets no
 * pongs either. While our own sends are still queued, silence is given this many idle
 * timeouts before the relay counts as dead.
 */
const BACKLOGGED_IDLE_FACTOR = 3

function describeClose(code: number, reason: string, role: string): string {
  switch (code) {
    case RelayCloseCode.Auth: return `Relay refused this ${role}`
    case RelayCloseCode.HelloTimeout: return `Relay timed out waiting for this ${role}`
    case RelayCloseCode.Replaced: return 'Another connection took over'
    case RelayCloseCode.Rate: return 'Rate limited by the relay'
    case RelayCloseCode.TooBig: return 'Message too large for the relay'
    case RelayCloseCode.GoingAway: return 'Relay went away'
  }
  return reason || 'Connection lost'
}

/**
 * A host's connection to the relay (SPEC.md §3), as a desktop or a server: opens
 * `<relay>/v1`, answers the challenge, keeps the socket alive with pings, notices a
 * silent one, and reconnects with exponential backoff until `close()`. Only `frame`,
 * `peer`, `pushed` and `error` reach the listeners, and only after `ready`; binary
 * frames (§3.9) go to `onBinaryFrame` listeners.
 */
export class RelayClient implements RelayTransport {
  private readonly timers: RelayClientTimers
  private readonly createSocket: (url: string) => WebSocketLike
  private readonly log: (message: string) => void
  private readonly minBackoff: number
  private readonly maxBackoff: number
  private state: RelayTransportState = { kind: 'idle' }
  private socket: WebSocketLike | null = null
  private url: string | null = null
  private ready = false
  private backoff: number
  private lastError: string | undefined
  private reconnectTimer: unknown = null
  private authTimer: unknown = null
  private pingTimer: unknown = null
  private lastReceivedAt = 0
  private readyBinary = false
  private drainTimer: unknown = null
  private readonly drainWaiters: { below: number; fn: () => void }[] = []
  private readonly role: Exclude<Role, 'phone'>
  private readonly messageListeners = new Set<(message: RelayServerMessage) => void>()
  private readonly binaryListeners = new Set<(from: string, envelope: Uint8Array) => void>()
  private readonly stateListeners = new Set<(state: RelayTransportState) => void>()

  constructor(private readonly options: RelayClientOptions) {
    this.timers = options.timers ?? realTimers
    this.createSocket = options.createSocket ?? defaultSocket
    this.log = options.log ?? (() => {})
    this.minBackoff = options.minBackoffMs ?? 1000
    this.maxBackoff = options.maxBackoffMs ?? 30_000
    this.backoff = this.minBackoff
    this.role = options.role ?? 'desktop'
  }

  /** The URL `connect` was given (without `/v1`), or null while closed. */
  get relayUrl(): string | null {
    return this.url === null ? null : this.url.slice(0, -RELAY_PATH.length)
  }

  connect(relayUrl: string): void {
    this.url = relayUrl.replace(/\/+$/, '') + RELAY_PATH
    this.backoff = this.minBackoff
    this.open()
  }

  close(): void {
    this.url = null
    this.clearTimers()
    this.dropSocket(1000, 'closing')
    this.setState({ kind: 'idle' })
  }

  /** Any message a host may send after `ready` (SPEC.md §3.2–§3.4). False when not online. */
  send(message: ClientMessage): boolean {
    if (!this.ready) return false
    return this.write(message)
  }

  /** A binary frame `[peer][envelope]` (SPEC.md §3.9). False when not online. */
  sendBinary(peer: string, envelope: Uint8Array): boolean {
    if (!this.ready) return false
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) return false
    try {
      socket.send(encodeRelayBinaryFrame(peer, envelope))
      return true
    } catch {
      return false
    }
  }

  /** Whether the relay confirmed binary frames in `ready` (false on a relay from before servers, §3.11). */
  isBinary(): boolean {
    return this.ready && this.readyBinary
  }

  /** Bytes we sent that the OS hasn't taken yet (0 without a socket). */
  bufferedAmount(): number {
    return this.socket?.bufferedAmount ?? 0
  }

  /**
   * Calls `fn` once `bufferedAmount()` is at most `below`, or once the socket is gone
   * (the caller then finds whatever it waited to send has nowhere to go).
   */
  onBufferBelow(below: number, fn: () => void): void {
    if (this.bufferedAmount() <= below || !this.socket) {
      fn()
      return
    }
    this.drainWaiters.push({ below, fn })
    if (this.drainTimer === null) {
      this.drainTimer = this.timers.setInterval(() => this.checkDrain(), DRAIN_POLL_MS)
    }
  }

  getState(): RelayTransportState {
    return this.state
  }

  onMessage(listener: (message: RelayServerMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => { this.messageListeners.delete(listener) }
  }

  /** Binary frames from `from`: the envelope is a fresh copy the listener may keep. */
  onBinaryFrame(listener: (from: string, envelope: Uint8Array) => void): () => void {
    this.binaryListeners.add(listener)
    return () => { this.binaryListeners.delete(listener) }
  }

  onStateChange(listener: (state: RelayTransportState) => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  // ---- connection lifecycle ------------------------------------------------------

  private open(): void {
    if (!this.url) return
    this.clearTimers()
    this.dropSocket(1000, 'reconnecting')
    this.setState({ kind: 'connecting' })
    let socket: WebSocketLike
    try {
      socket = this.createSocket(this.url)
    } catch (err) {
      this.failed(err instanceof Error ? err.message : String(err))
      return
    }
    this.socket = socket
    if (this.options.binary) socket.binaryType = 'arraybuffer'
    this.lastReceivedAt = this.timers.now()
    const authTimeout = this.options.authTimeoutMs ?? 15_000
    this.authTimer = this.timers.setTimeout(() => {
      this.authTimer = null
      if (this.socket === socket && !this.ready) this.failed('Relay did not answer')
    }, authTimeout)
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.lastReceivedAt = this.timers.now()
      if (typeof event.data === 'string') this.handle(event.data)
      else this.handleBinary(event.data)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.failed(describeClose(event.code, event.reason, this.role))
    }
    socket.onerror = () => {
      // `close` follows with the code; remember that the attempt itself failed.
      if (this.socket === socket && !this.ready) this.lastError = 'Relay unreachable'
    }
  }

  private handleBinary(data: unknown): void {
    if (!this.ready) return
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    else return
    let frame: { peer: string; envelope: Uint8Array }
    try {
      frame = decodeRelayBinaryFrame(bytes)
    } catch (err) {
      this.log(`relay sent a malformed binary frame: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    for (const listener of this.binaryListeners) listener(frame.peer, frame.envelope)
  }

  private handle(text: string): void {
    let message: ServerMessage | null
    try {
      message = parseServerMessage(text)
    } catch (err) {
      this.log(`relay sent a malformed message: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!message) return
    switch (message.t) {
      case 'challenge': {
        const keys = this.options.ed25519()
        this.write(buildHello({ role: this.role, nonce: message.nonce, ed25519Priv: keys.priv, ed25519Pub: keys.pub, binary: this.options.binary }))
        return
      }
      case 'ready':
        if (message.id !== this.options.deviceId()) {
          this.log(`relay says our id is ${message.id}, expected ${this.options.deviceId()}`)
        }
        this.readyBinary = message.binary === true
        if (this.options.binary && !this.readyBinary) this.log('relay did not confirm binary frames (a relay from before servers)')
        this.onReady()
        return
      case 'ping':
        this.write({ t: 'pong' })
        return
      case 'pong':
        return
      case 'frame':
      case 'peer':
      case 'pushed':
      case 'error':
        if (!this.ready) {
          if (message.t === 'error') this.lastError = message.message ?? `Relay error: ${message.code}`
          return
        }
        for (const listener of this.messageListeners) listener(message)
        return
    }
  }

  private onReady(): void {
    this.ready = true
    this.backoff = this.minBackoff
    this.lastError = undefined
    if (this.authTimer !== null) {
      this.timers.clearTimeout(this.authTimer)
      this.authTimer = null
    }
    const pingEvery = this.options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS
    const idleAfter = this.options.idleTimeoutMs ?? RELAY_IDLE_TIMEOUT_MS
    this.pingTimer = this.timers.setInterval(() => {
      // Only total silence counts (§3.10): a relay holding our socket back delays
      // our pongs too, so while our own sends are still queued it gets longer.
      const silent = this.timers.now() - this.lastReceivedAt
      const backlogged = this.bufferedAmount() > 0
      if (silent >= idleAfter && (!backlogged || silent >= idleAfter * BACKLOGGED_IDLE_FACTOR)) {
        this.failed('Relay stopped responding')
        return
      }
      this.write({ t: 'ping' })
    }, pingEvery)
    this.setState({ kind: 'online' })
  }

  /** This attempt is over: tell the service and schedule the next one. */
  private failed(reason: string): void {
    const error = this.lastError && !this.ready ? this.lastError : reason
    this.lastError = undefined
    this.clearTimers()
    this.dropSocket(1000, 'retrying')
    if (!this.url) return
    this.setState({ kind: 'offline', error })
    const delay = this.backoff
    this.backoff = Math.min(this.maxBackoff, this.backoff * 2)
    this.log(`relay offline (${error}); retrying in ${delay} ms`)
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private dropSocket(code: number, reason: string): void {
    const socket = this.socket
    this.socket = null
    this.ready = false
    this.readyBinary = false
    this.checkDrain()
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
    try { socket.close(code, reason) } catch { /* already closed */ }
  }

  /** Runs the drain waiters whose mark was reached (all of them once the socket is gone). */
  private checkDrain(): void {
    if (this.drainWaiters.length === 0) return
    const buffered = this.bufferedAmount()
    const gone = !this.socket
    const due = this.drainWaiters.filter((w) => gone || buffered <= w.below)
    if (due.length > 0) {
      const remaining = this.drainWaiters.filter((w) => !due.includes(w))
      this.drainWaiters.length = 0
      this.drainWaiters.push(...remaining)
    }
    if (this.drainWaiters.length === 0 && this.drainTimer !== null) {
      this.timers.clearInterval(this.drainTimer)
      this.drainTimer = null
    }
    for (const waiter of due) waiter.fn()
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) { this.timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.authTimer !== null) { this.timers.clearTimeout(this.authTimer); this.authTimer = null }
    if (this.pingTimer !== null) { this.timers.clearInterval(this.pingTimer); this.pingTimer = null }
  }

  private write(message: ClientMessage): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) return false
    try {
      socket.send(encodeRelayMessage(message))
      return true
    } catch {
      return false
    }
  }

  private setState(state: RelayTransportState): void {
    const same = this.state.kind === state.kind
      && (this.state as { error?: string }).error === (state as { error?: string }).error
    this.state = state
    if (same) return
    for (const listener of this.stateListeners) listener(state)
  }
}

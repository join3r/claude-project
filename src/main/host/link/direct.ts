import type { DataChannel, PeerConnection } from 'node-datachannel'
import { errorMessage } from './errors'

/**
 * The direct path of the desktop↔server link (protocol/SERVER.md §13): a WebRTC
 * data channel (libdatachannel through `node-datachannel`) that punches through
 * NAT with the relay's STUN responder. The offer and answer travel inside the
 * relay session, which is already end-to-end encrypted, and the pipe then carries
 * its own Noise session, so the relay never learns more than it did.
 *
 * `node-datachannel` is native. It loads on first use and a host without it (an
 * unsupported platform, a broken install) has no direct path: everything stays
 * on the relay.
 */

/** The server's handshake reply lists this when it answers `server-direct-offer`. */
export const DIRECT_FEATURE = 'direct'
/** The relay's STUN responder listens on this UDP port of the relay's host. */
export const DEFAULT_STUN_PORT = 3478
/** Gathering candidates (host, then server-reflexive from STUN) gets this long. */
export const GATHER_TIMEOUT_MS = 5000
/** ICE checks, DTLS and SCTP get this long to open the channel. */
export const CONNECT_TIMEOUT_MS = 15_000
/** A pipe sends a heartbeat this often... */
export const HEARTBEAT_MS = 10_000
/** ...and closes once it has heard nothing at all for this long. */
export const SILENCE_MS = 35_000
/** A pipe that drops to `disconnected` gets this long to come back. */
const DISCONNECTED_GRACE_MS = 10_000

/** Pipe messages: envelopes (`0x01`–`0x04`, SPEC.md §4.1) and this one-byte heartbeat. */
const HEARTBEAT = new Uint8Array([0x00])

/** What one side sends the other: its SDP and every candidate it gathered. */
export interface DirectSignal {
  sdp: string
  candidates: { candidate: string; mid: string }[]
}

/** A reliable, ordered message pipe to the peer. */
export interface DirectPipe {
  /** False when the pipe is closed (or the message didn't fit). */
  send(bytes: Uint8Array): boolean
  bufferedAmount(): number
  /** `fn` once the queue is back under `threshold` bytes, or the pipe closes. */
  whenBelow(threshold: number, fn: () => void): void
  onMessage(fn: (bytes: Uint8Array) => void): void
  /** Once, whichever way it ends (closed by either side, ICE failure, silence). */
  onClose(fn: (why: string) => void): void
  close(why?: string): void
  readonly closed: boolean
  /** `host 192.168.1.4:51234 ↔ srflx 1.2.3.4:40000`, for logs and the UI. */
  describe(): string
  /** The selected pair's remote candidate type: `host` (same network), `srflx`/`prflx` (through NAT). */
  kind(): string
}

/** The desktop's offer, waiting for the server's answer. */
export interface DirectOffer {
  signal: DirectSignal
  /** Applies the answer; resolves when the channel opens, rejects on failure or timeout. */
  connect(answer: DirectSignal, timeoutMs?: number): Promise<DirectPipe>
  close(): void
}

/** The server's answer and the pipe it will become. */
export interface DirectAnswer {
  signal: DirectSignal
  pipe: Promise<DirectPipe>
  close(): void
}

export interface DirectOptions {
  iceServers: string[]
  log: (message: string) => void
}

export interface DirectApi {
  offer(options: DirectOptions): Promise<DirectOffer>
  answer(offer: DirectSignal, options: DirectOptions, timeoutMs?: number): Promise<DirectAnswer>
}

type Ndc = typeof import('node-datachannel')

let loading: Promise<DirectApi | null> | null = null

/**
 * The direct path's API, or null when `node-datachannel` doesn't load here (or
 * `DEVTOOL_NO_DIRECT` is set). Loaded once.
 */
export function loadDirect(log: (message: string) => void): Promise<DirectApi | null> {
  if (process.env.DEVTOOL_NO_DIRECT) return Promise.resolve(null)
  loading ??= import('node-datachannel').then(
    (mod) => {
      const ndc = ((mod as unknown as { default?: Ndc }).default ?? mod) as Ndc
      if (typeof ndc.PeerConnection !== 'function') throw new Error('no PeerConnection export')
      return directApi(ndc)
    },
    (err: unknown) => {
      log(`direct path unavailable: ${errorMessage(err)}`)
      return null
    }
  )
  return loading
}

/**
 * `stun:<relay host>:3478`, the STUN responder of the relay this host already
 * uses (`DEVTOOL_STUN` overrides it: a `stun:` URL, or empty for none).
 */
export function stunServersFor(relayUrl: string): string[] {
  const override = process.env.DEVTOOL_STUN
  if (override !== undefined) return override.split(',').map((s) => s.trim()).filter(Boolean)
  try {
    const host = new URL(relayUrl).hostname
    if (!host) return []
    return [`stun:${host.includes(':') ? `[${host}]` : host}:${DEFAULT_STUN_PORT}`]
  } catch {
    return []
  }
}

/** Checks a signal from the other side (it came through the link, so it is only shape-checked). */
export function parseSignal(value: unknown): DirectSignal {
  const v = value as Partial<DirectSignal> | null
  if (!v || typeof v.sdp !== 'string' || v.sdp.length > 64 * 1024 || !Array.isArray(v.candidates) || v.candidates.length > 64) {
    throw new Error('bad direct signal')
  }
  const candidates = v.candidates.map((c) => {
    const x = c as { candidate?: unknown; mid?: unknown } | null
    if (!x || typeof x.candidate !== 'string' || typeof x.mid !== 'string' || x.candidate.length > 1024 || x.mid.length > 64) throw new Error('bad direct candidate')
    return { candidate: x.candidate, mid: x.mid }
  })
  return { sdp: v.sdp, candidates }
}

function directApi(ndc: Ndc): DirectApi {
  return {
    async offer(options) {
      const pc = new ndc.PeerConnection('devtool-desktop', { iceServers: options.iceServers })
      const gathered = gather(pc, options)
      let dc: DataChannel
      try {
        dc = pc.createDataChannel('link')
      } catch (err) {
        pc.close()
        throw err
      }
      let signal: DirectSignal
      try {
        signal = await gathered
      } catch (err) {
        pc.close()
        throw err
      }
      return {
        signal,
        connect: (answer, timeoutMs = CONNECT_TIMEOUT_MS) => {
          try {
            pc.setRemoteDescription(answer.sdp, 'answer')
            for (const c of answer.candidates) pc.addRemoteCandidate(c.candidate, c.mid)
          } catch (err) {
            pc.close()
            return Promise.reject(err instanceof Error ? err : new Error(String(err)))
          }
          return opened(pc, dc, timeoutMs, options)
        },
        close: () => pc.close()
      }
    },

    async answer(offer, options, timeoutMs = CONNECT_TIMEOUT_MS) {
      const pc = new ndc.PeerConnection('devtool-server', { iceServers: options.iceServers })
      const channel = new Promise<DataChannel>((resolve) => pc.onDataChannel(resolve))
      const gathered = gather(pc, options)
      try {
        pc.setRemoteDescription(offer.sdp, 'offer')
        for (const c of offer.candidates) pc.addRemoteCandidate(c.candidate, c.mid)
      } catch (err) {
        pc.close()
        throw err
      }
      let signal: DirectSignal
      try {
        signal = await gathered
      } catch (err) {
        pc.close()
        throw err
      }
      const pipe = withTimeout(channel, timeoutMs, 'the direct channel did not open').then(
        (dc) => opened(pc, dc, timeoutMs, options),
        (err: unknown) => {
          pc.close()
          throw err
        }
      )
      // Nobody may be waiting yet: an unhandled rejection would be noise.
      pipe.catch(() => {})
      return { signal, pipe, close: () => pc.close() }
    }
  }
}

/** Waits for gathering to finish (or {@link GATHER_TIMEOUT_MS}), then reads the description. */
function gather(pc: PeerConnection, options: DirectOptions): Promise<DirectSignal> {
  const candidates: { candidate: string; mid: string }[] = []
  let sdp: string | null = null
  pc.onLocalCandidate((candidate, mid) => candidates.push({ candidate, mid }))
  pc.onLocalDescription((description) => { sdp = description })
  return new Promise((resolve, reject) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      const description = sdp ?? pc.localDescription()?.sdp ?? null
      if (!description) {
        reject(new Error('no local description'))
        return
      }
      if (candidates.length === 0) options.log('direct gathered no candidates')
      resolve({ sdp: description, candidates: [...candidates] })
    }
    const timer = setTimeout(finish, GATHER_TIMEOUT_MS)
    pc.onGatheringStateChange((state) => {
      if (state === 'complete') setImmediate(finish)
    })
    if (pc.gatheringState() === 'complete') setImmediate(finish)
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))) }
    )
  })
}

/** Resolves with the pipe once `dc` is open, or rejects (closing the connection). */
function opened(pc: PeerConnection, dc: DataChannel, timeoutMs: number, options: DirectOptions): Promise<DirectPipe> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (why: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { pc.close() } catch { /* already closed */ }
      reject(new Error(why))
    }
    const timer = setTimeout(() => fail('the direct channel did not open in time'), timeoutMs)
    const open = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(new DataChannelPipe(pc, dc, options))
    }
    pc.onStateChange((state) => {
      if (state === 'failed' || state === 'closed') fail(`the direct connection ${state}`)
    })
    dc.onClosed(() => fail('the direct channel closed'))
    dc.onError((err) => fail(`the direct channel failed: ${err}`))
    dc.onOpen(open)
    if (dc.isOpen()) open()
  })
}

class DataChannelPipe implements DirectPipe {
  closed = false
  private readonly messageHandlers: ((bytes: Uint8Array) => void)[] = []
  private readonly closeHandlers: ((why: string) => void)[] = []
  private readonly below: { threshold: number; fn: () => void }[] = []
  private readonly early: Uint8Array[] = []
  private heartbeat: ReturnType<typeof setInterval>
  private lastHeard = Date.now()
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null
  private readonly description: string
  private readonly remoteKind: string

  constructor(private readonly pc: PeerConnection, private readonly dc: DataChannel, private readonly options: DirectOptions) {
    let description = 'direct'
    let remoteKind = 'unknown'
    try {
      const pair = pc.getSelectedCandidatePair()
      if (pair) {
        description = `${pair.local.type} ${pair.local.address}:${pair.local.port} ↔ ${pair.remote.type} ${pair.remote.address}:${pair.remote.port}`
        remoteKind = pair.remote.type
      }
    } catch { /* no pair to show */ }
    this.description = description
    this.remoteKind = remoteKind
    dc.onMessage((message) => {
      this.lastHeard = Date.now()
      if (typeof message === 'string') return
      const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
      if (bytes.length === 1 && bytes[0] === HEARTBEAT[0]) return
      if (this.messageHandlers.length === 0) {
        this.early.push(Uint8Array.from(bytes))
        return
      }
      for (const handler of this.messageHandlers) handler(bytes)
    })
    dc.onClosed(() => this.close('the peer closed the direct channel'))
    dc.onError((err) => this.close(`the direct channel failed: ${err}`))
    dc.onBufferedAmountLow(() => this.drain())
    pc.onStateChange((state) => {
      if (state === 'failed' || state === 'closed') {
        this.close(`the direct connection ${state}`)
      } else if (state === 'disconnected') {
        this.disconnectedTimer ??= setTimeout(() => this.close('the direct connection stayed disconnected'), DISCONNECTED_GRACE_MS)
      } else if (state === 'connected' && this.disconnectedTimer) {
        clearTimeout(this.disconnectedTimer)
        this.disconnectedTimer = null
      }
    })
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_MS) {
        this.close('the direct path went silent')
        return
      }
      this.sendRaw(HEARTBEAT)
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  send(bytes: Uint8Array): boolean {
    return this.sendRaw(bytes)
  }

  bufferedAmount(): number {
    if (this.closed) return 0
    try {
      return this.dc.bufferedAmount()
    } catch {
      return 0
    }
  }

  whenBelow(threshold: number, fn: () => void): void {
    if (this.closed || this.bufferedAmount() <= threshold) {
      fn()
      return
    }
    this.below.push({ threshold, fn })
    const lowest = Math.min(...this.below.map((b) => b.threshold))
    try { this.dc.setBufferedAmountLowThreshold(lowest) } catch { /* closing */ }
  }

  onMessage(fn: (bytes: Uint8Array) => void): void {
    this.messageHandlers.push(fn)
    for (const bytes of this.early.splice(0)) fn(bytes)
  }

  onClose(fn: (why: string) => void): void {
    this.closeHandlers.push(fn)
  }

  close(why = 'closed'): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer)
    try { this.dc.close() } catch { /* already closed */ }
    try { this.pc.close() } catch { /* already closed */ }
    this.options.log(`direct closed (${why})`)
    this.drain()
    for (const handler of this.closeHandlers.splice(0)) handler(why)
  }

  describe(): string {
    return this.description
  }

  kind(): string {
    return this.remoteKind
  }

  private sendRaw(bytes: Uint8Array): boolean {
    if (this.closed) return false
    try {
      return this.dc.sendMessageBinary(bytes) !== false
    } catch (err) {
      this.close(`send failed: ${errorMessage(err)}`)
      return false
    }
  }

  private drain(): void {
    const amount = this.bufferedAmount()
    const ready = this.below.filter((b) => this.closed || amount <= b.threshold)
    if (ready.length === 0) return
    for (let i = this.below.length - 1; i >= 0; i--) if (ready.includes(this.below[i])) this.below.splice(i, 1)
    for (const { fn } of ready) fn()
  }
}

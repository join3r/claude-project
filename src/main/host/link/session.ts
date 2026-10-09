import { ProtocolError } from '../../../../protocol/ts/index.ts'
import { LinkError, LinkErrorCode, errorMessage } from './errors'
import { LinkStream, type StreamKinds, type StreamSession } from './stream'
import {
  LINK_MAX_MESSAGE,
  LINK_PREFIX_BYTES,
  decodeLinkMessage,
  encodeLinkMessage,
  type CallMessage,
  type LinkMessage,
  type StreamCloseReason
} from './wire'
import { FRAGMENT_CHUNK } from '../../../../protocol/ts/index.ts'

/** Where a session's messages go: the sealed channel over the relay, or a loopback in tests. */
export interface LinkTransport {
  /** Send one link message's plaintext. False when the link is gone. */
  send(plaintext: Uint8Array): boolean
  /** The socket is over its high-water mark: whatever can wait (streams) should. */
  congested(): boolean
  /** `fn` once the socket is back under its low-water mark, or the link is gone. */
  whenDrained(fn: () => void): void
}

export interface IncomingCall {
  client: string
  ch: string
  args: unknown[]
  focused: boolean
}

export interface IncomingEvent {
  client: string
  ch: string
  args: unknown[]
}

export interface CoalesceOptions {
  /** The event to batch: `[key, text]` events with the same client and key are concatenated. */
  channel: string
  /** How long a batch may wait (plan: 16 ms for `pty-data`). */
  windowMs: number
  /** Most characters in one message; a batch that grows past it goes out at once, in pieces. */
  maxChars: number
}

export interface LinkTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface LinkSessionOptions {
  transport: LinkTransport
  /** Stream ids: the desktop (initiator) opens odd ones, the server even ones. */
  side: 'desktop' | 'server'
  /** Answers `call`s. Without it every call is refused (`unsupported`): a server doesn't call its desktops. */
  onCall?: (call: IncomingCall) => Promise<unknown>
  onEvent?: (event: IncomingEvent) => void
  onDetach?: (client: string) => void
  /** Stream kinds this side accepts. */
  streams?: StreamKinds
  /** Who the peer is, for stream handlers. */
  peer: string
  coalesce?: CoalesceOptions
  log: (message: string) => void
  timers?: LinkTimers
}

const realTimers: LinkTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** A `data` message's payload fits one unfragmented plaintext with room for its header. */
const MAX_DATA_BYTES = FRAGMENT_CHUNK - LINK_PREFIX_BYTES - 32

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface Batch {
  client: string
  key: string
  parts: string[]
  chars: number
}

/** Cuts `text` into pieces of at most `max` UTF-16 units without splitting a surrogate pair. */
function pieces(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + max)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    out.push(text.slice(start, end))
    start = end
  }
  return out
}

/**
 * The link's app layer over one established session (protocol/SERVER.md §4–§6):
 * calls and their results, events, client detaches and multiplexed streams.
 * Order is kept per session: with coalescing on, any message other than the
 * coalesced event first flushes the pending batches, so a `pty-exit` (or a call's
 * result) never overtakes the output before it.
 */
export class LinkSession implements StreamSession {
  readonly maxDataBytes = MAX_DATA_BYTES
  private readonly options: LinkSessionOptions
  private readonly timers: LinkTimers
  private readonly pendingCalls = new Map<number, PendingCall>()
  private readonly streams = new Map<number, LinkStream>()
  private readonly batches = new Map<string, Batch>()
  private batchTimer: unknown = null
  private nextCallId = 1
  private nextSid: number
  private closedWith: LinkError | null = null

  constructor(options: LinkSessionOptions) {
    this.options = options
    this.timers = options.timers ?? realTimers
    this.nextSid = options.side === 'desktop' ? 1 : 2
  }

  get closed(): boolean {
    return this.closedWith !== null
  }

  /** Calls waiting for their result. */
  get pendingCallCount(): number {
    return this.pendingCalls.size
  }

  get openStreamCount(): number {
    return this.streams.size
  }

  // ---- calls -------------------------------------------------------------------------

  /** Runs `ch` on the peer as `client`. Rejects with LinkError on a refusal, a handler error or a lost link. */
  call(client: string, ch: string, args: unknown[], focused = false): Promise<unknown> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const id = this.nextCallId++
    let bytes: Uint8Array
    try {
      bytes = encodeLinkMessage({ type: 'call', id, client, ch, args, ...(focused ? { focused } : {}) })
    } catch (err) {
      return Promise.reject(err instanceof LinkError ? err : new LinkError(LinkErrorCode.Protocol, errorMessage(err)))
    }
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject })
      if (!this.write(bytes)) {
        this.pendingCalls.delete(id)
        reject(this.closedWith ?? new LinkError(LinkErrorCode.ServerOffline, 'The server is offline'))
      }
    })
  }

  // ---- events ------------------------------------------------------------------------

  /** A push for `client` (`*` for every client of the peer). Never dropped while the link is up. */
  sendEvent(client: string, ch: string, args: unknown[]): void {
    if (this.closedWith) return
    const coalesce = this.options.coalesce
    if (coalesce && ch === coalesce.channel && args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'string') {
      this.batch(client, args[0], args[1], coalesce)
      return
    }
    this.flush()
    this.writeMessage({ type: 'event', client, ch, args }, `event ${ch}`)
  }

  /** The peer's client went away (a window closed). */
  detach(client: string): void {
    if (this.closedWith) return
    this.flush()
    this.writeMessage({ type: 'detach', client }, 'detach')
  }

  /** Sends every pending batch now. */
  flush(): void {
    if (this.batchTimer !== null) {
      this.timers.clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    if (this.batches.size === 0) return
    const batches = [...this.batches.values()]
    this.batches.clear()
    const coalesce = this.options.coalesce!
    for (const batch of batches) {
      const text = batch.parts.join('')
      for (const piece of pieces(text, coalesce.maxChars)) {
        this.writeMessage({ type: 'event', client: batch.client, ch: coalesce.channel, args: [batch.key, piece] }, `event ${coalesce.channel}`)
      }
    }
  }

  private batch(client: string, key: string, text: string, coalesce: CoalesceOptions): void {
    const id = `${client}\u0000${key}`
    let batch = this.batches.get(id)
    if (!batch) {
      batch = { client, key, parts: [], chars: 0 }
      this.batches.set(id, batch)
    }
    batch.parts.push(text)
    batch.chars += text.length
    if (batch.chars >= coalesce.maxChars) {
      this.flush()
      return
    }
    if (this.batchTimer === null) {
      this.batchTimer = this.timers.setTimeout(() => {
        this.batchTimer = null
        this.flush()
      }, coalesce.windowMs)
    }
  }

  // ---- streams -----------------------------------------------------------------------

  /**
   * Opens a stream of `kind` on the peer. Writes may start at once; a refusal, an
   * abort or the end of the session destroys it with a LinkError, so listen for
   * `error` as with any Node stream.
   */
  openStream(kind: string, params: unknown = null): LinkStream {
    if (this.closedWith) throw this.closedWith
    const sid = this.nextSid
    this.nextSid += 2
    const stream = new LinkStream(this, sid, kind, params)
    this.streams.set(sid, stream)
    this.flush()
    if (!this.writeMessage({ type: 'open', sid, kind, params }, 'open')) {
      this.streams.delete(sid)
      throw this.closedWith ?? new LinkError(LinkErrorCode.ServerOffline, 'The server is offline')
    }
    return stream
  }

  sendData(sid: number, bytes: Uint8Array): boolean {
    if (this.closedWith) return false
    return this.write(encodeLinkMessage({ type: 'data', sid, bytes }))
  }

  sendCredit(sid: number, n: number): void {
    if (this.closedWith) return
    this.write(encodeLinkMessage({ type: 'credit', sid, n }))
  }

  sendClose(sid: number, reason: StreamCloseReason, message?: string): void {
    if (this.closedWith) return
    this.writeMessage({ type: 'close', sid, reason, ...(message ? { message } : {}) }, 'close')
  }

  congested(): boolean {
    return this.options.transport.congested()
  }

  whenDrained(fn: () => void): void {
    this.options.transport.whenDrained(fn)
  }

  forget(sid: number): void {
    this.streams.delete(sid)
  }

  // ---- receiving ---------------------------------------------------------------------

  /** One whole link message from the peer. Malformed ones are logged and dropped. */
  receive(plaintext: Uint8Array): void {
    if (this.closedWith) return
    let message: LinkMessage
    try {
      message = decodeLinkMessage(plaintext)
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      this.options.log(`link peer=${this.options.peer} bad message: ${err.message}`)
      return
    }
    switch (message.type) {
      case 'call':
        this.answer(message)
        return
      case 'result': {
        const pending = this.pendingCalls.get(message.id)
        if (!pending) return
        this.pendingCalls.delete(message.id)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new LinkError(message.error.code, message.error.message))
        return
      }
      case 'event':
        this.options.onEvent?.({ client: message.client, ch: message.ch, args: message.args })
        return
      case 'detach':
        this.options.onDetach?.(message.client)
        return
      case 'open':
        this.accept(message.sid, message.kind, message.params)
        return
      case 'data': {
        const stream = this.streams.get(message.sid)
        stream?.onData(message.bytes)
        return
      }
      case 'credit':
        this.streams.get(message.sid)?.onCredit(message.n)
        return
      case 'close': {
        const stream = this.streams.get(message.sid)
        if (!stream) return
        if (message.reason === 'end') stream.onRemoteEnd()
        else stream.onAbort(new LinkError(message.reason === 'refused' ? LinkErrorCode.Refused : LinkErrorCode.Aborted, message.message ?? `The stream was ${message.reason === 'refused' ? 'refused' : 'aborted'}`))
        return
      }
    }
  }

  /**
   * The session is over (the link dropped, a new handshake replaced it): pending
   * calls reject with `error`, streams abort, batches are dropped with the link.
   */
  close(error: LinkError): void {
    if (this.closedWith) return
    this.closedWith = error
    if (this.batchTimer !== null) {
      this.timers.clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    this.batches.clear()
    for (const pending of this.pendingCalls.values()) pending.reject(error)
    this.pendingCalls.clear()
    for (const stream of [...this.streams.values()]) stream.onAbort(error)
    this.streams.clear()
  }

  // ---- internals ---------------------------------------------------------------------

  private answer(call: CallMessage): void {
    const onCall = this.options.onCall
    const run = onCall
      ? Promise.resolve().then(() => onCall({ client: call.client, ch: call.ch, args: call.args, focused: call.focused === true }))
      : Promise.reject(new LinkError(LinkErrorCode.Unsupported, 'This side takes no calls'))
    run.then(
      (value) => {
        if (this.closedWith) return
        this.flush()
        try {
          this.write(encodeLinkMessage({ type: 'result', id: call.id, ok: true, value }))
        } catch (err) {
          const code = err instanceof LinkError ? err.code : LinkErrorCode.Protocol
          this.options.log(`link peer=${this.options.peer} result ch=${call.ch} not sent: ${errorMessage(err)}`)
          this.write(encodeLinkMessage({
            type: 'result', id: call.id, ok: false,
            error: { code, message: code === LinkErrorCode.TooLarge ? `${errorMessage(err)}; ${call.ch} needs a stream for this much data` : errorMessage(err) }
          }))
        }
      },
      (err: unknown) => {
        if (this.closedWith) return
        this.flush()
        const code = err instanceof LinkError ? err.code : LinkErrorCode.Remote
        this.write(encodeLinkMessage({ type: 'result', id: call.id, ok: false, error: { code, message: errorMessage(err).slice(0, 4000) } }))
      }
    )
  }

  private accept(sid: number, kind: string, params: unknown): void {
    const ours = this.options.side === 'desktop' ? sid % 2 === 1 : sid % 2 === 0
    const handler = this.options.streams?.get(kind)
    if (ours || sid === 0 || this.streams.has(sid) || !handler) {
      this.writeMessage({ type: 'close', sid, reason: 'refused', message: handler ? 'bad stream id' : `unknown stream kind ${kind}` }, 'close')
      return
    }
    const stream = new LinkStream(this, sid, kind, params)
    this.streams.set(sid, stream)
    const fail = (err: unknown) => {
      this.options.log(`link peer=${this.options.peer} stream=${sid} kind=${kind} failed: ${errorMessage(err)}`)
      if (!stream.destroyed) stream.destroy(err instanceof Error ? err : new Error(String(err)))
    }
    // A stream nobody listens for errors on would crash the process on its first one.
    stream.on('error', (err) => this.options.log(`link peer=${this.options.peer} stream=${sid} kind=${kind} error: ${err.message}`))
    try {
      const result = handler(stream, { peer: this.options.peer })
      if (result instanceof Promise) result.catch(fail)
    } catch (err) {
      fail(err)
    }
  }

  private writeMessage(message: LinkMessage, what: string): boolean {
    let bytes: Uint8Array
    try {
      bytes = encodeLinkMessage(message)
    } catch (err) {
      this.options.log(`link peer=${this.options.peer} ${what} dropped: ${errorMessage(err)}`)
      return false
    }
    return this.write(bytes)
  }

  private write(bytes: Uint8Array): boolean {
    if (this.closedWith) return false
    if (bytes.length > LINK_MAX_MESSAGE) return false
    return this.options.transport.send(bytes)
  }
}

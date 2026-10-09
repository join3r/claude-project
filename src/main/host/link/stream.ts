import { Duplex } from 'stream'
import { LinkError, LinkErrorCode } from './errors'
import type { StreamCloseReason } from './wire'

/** Bytes a stream's sender may have in flight before the receiver grants more (protocol/SERVER.md §6). */
export const STREAM_WINDOW = 256 * 1024
/** A receiver grants credit once at least this much of its window is free again. */
export const STREAM_CREDIT_STEP = 64 * 1024

/** What a stream needs from its session. */
export interface StreamSession {
  /** False when the link is gone. */
  sendData(sid: number, bytes: Uint8Array): boolean
  sendCredit(sid: number, n: number): void
  sendClose(sid: number, reason: StreamCloseReason, message?: string): void
  /** The socket under the link is over its high-water mark: wait for {@link whenDrained}. */
  congested(): boolean
  whenDrained(fn: () => void): void
  /** Largest payload of one `data` message. */
  readonly maxDataBytes: number
  /** The stream is over: drop it from the session's table. */
  forget(sid: number): void
}

interface PendingWrite {
  chunk: Uint8Array
  offset: number
  callback: (error?: Error | null) => void
}

/**
 * One multiplexed byte stream over the link, as a Node Duplex: write to send,
 * read (or pipe) to receive. Credit-based flow control keeps at most
 * {@link STREAM_WINDOW} bytes in flight per direction: the sender stops when its
 * credit runs out, and the receiver grants more as its reader consumes, so a
 * slow reader holds the sender back instead of filling the relay.
 *
 * `end()` half-closes (the peer reads EOF); `destroy(err)` aborts both ways.
 */
export class LinkStream extends Duplex {
  readonly sid: number
  readonly kind: string
  readonly params: unknown
  private readonly session: StreamSession
  private sendCredit = STREAM_WINDOW
  private granted = STREAM_WINDOW
  private received = 0
  private readonly queue: PendingWrite[] = []
  private finalCallback: ((error?: Error | null) => void) | null = null
  private waitingForDrain = false
  private endSent = false
  private remoteEnded = false
  /** The peer aborted it, or the session went away: nothing more is sent. */
  private silenced = false

  constructor(session: StreamSession, sid: number, kind: string, params: unknown) {
    super({ readableHighWaterMark: STREAM_CREDIT_STEP, writableHighWaterMark: STREAM_CREDIT_STEP })
    this.session = session
    this.sid = sid
    this.kind = kind
    this.params = params
    this.once('close', () => session.forget(sid))
  }

  // ---- Duplex ------------------------------------------------------------------------

  override _write(chunk: Buffer | Uint8Array | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
    this.queue.push({ chunk: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0, callback })
    this.pump()
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.finalCallback = callback
    this.pump()
  }

  override _read(): void {
    this.grant()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.silenced && !(this.endSent && this.remoteEnded)) {
      this.session.sendClose(this.sid, 'error', error?.message ?? 'closed')
    }
    this.silenced = true
    const failure = error ?? new LinkError(LinkErrorCode.Aborted, 'The stream was closed')
    for (const pending of this.queue.splice(0)) pending.callback(failure)
    const final = this.finalCallback
    this.finalCallback = null
    final?.(failure)
    callback(error)
  }

  // ---- from the session ------------------------------------------------------------

  /** `credit {n}`: the peer's reader made room. */
  onCredit(n: number): void {
    this.sendCredit += n
    this.pump()
  }

  /** `data`: more than the peer was granted is a protocol error. */
  onData(bytes: Uint8Array): void {
    if (this.destroyed || this.remoteEnded) return
    if (bytes.length > this.granted - this.received) {
      this.destroy(new LinkError(LinkErrorCode.Protocol, `stream ${this.sid} sent past its credit`))
      return
    }
    this.received += bytes.length
    this.push(bytes)
  }

  /** `close {end}`: the peer sends no more; the reader gets EOF after what it has. */
  onRemoteEnd(): void {
    if (this.remoteEnded || this.destroyed) return
    this.remoteEnded = true
    this.push(null)
  }

  /** `close {error|refused}`, or the session went away: no more traffic either way. */
  onAbort(error: LinkError): void {
    if (this.destroyed) return
    this.silenced = true
    this.destroy(error)
  }

  // ---- flow control ----------------------------------------------------------------

  private pump(): void {
    while (this.queue.length > 0) {
      if (this.destroyed || this.silenced) return
      if (this.sendCredit <= 0) return
      if (this.session.congested()) {
        if (!this.waitingForDrain) {
          this.waitingForDrain = true
          this.session.whenDrained(() => {
            this.waitingForDrain = false
            this.pump()
          })
        }
        return
      }
      const head = this.queue[0]
      const n = Math.min(head.chunk.length - head.offset, this.sendCredit, this.session.maxDataBytes)
      if (!this.session.sendData(this.sid, head.chunk.subarray(head.offset, head.offset + n))) {
        this.onAbort(new LinkError(LinkErrorCode.ServerOffline, 'The link went away'))
        return
      }
      this.sendCredit -= n
      head.offset += n
      if (head.offset === head.chunk.length) {
        this.queue.shift()
        head.callback()
      }
    }
    const final = this.finalCallback
    if (final && !this.endSent && !this.destroyed) {
      this.endSent = true
      this.finalCallback = null
      this.session.sendClose(this.sid, 'end')
      final()
    }
  }

  /** Grant what the window has free again: in flight plus unread stays within {@link STREAM_WINDOW}. */
  private grant(): void {
    if (this.remoteEnded || this.destroyed || this.silenced) return
    const free = STREAM_WINDOW - (this.granted - this.received) - this.readableLength
    if (free < STREAM_CREDIT_STEP) return
    this.granted += free
    this.session.sendCredit(this.sid, free)
  }
}

/** The receiving end of an `open`: a handler per kind. Throwing or rejecting aborts the stream. */
export type StreamHandler = (stream: LinkStream, context: { peer: string }) => void | Promise<void>

/** Stream kinds a side accepts, by name (`echo`, later `bundle`, `file`, `tcp`). */
export type StreamKinds = ReadonlyMap<string, StreamHandler>

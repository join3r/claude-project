import { Buffer, isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  CloseCode,
  FrameParser,
  Opcode,
  WebSocketProtocolError,
  encodeClosePayload,
  encodeFrame,
  isValidCloseCode
} from './frames.ts'
import type { Frame } from './frames.ts'

/**
 * A minimal RFC 6455 server connection over a socket handed over by `http`'s `upgrade`
 * event. It supports what the relay needs: text and binary messages (with
 * fragmentation), ping/pong, the close handshake and a hard payload cap. No extensions
 * and no subprotocols.
 *
 * For the relay's flow control (SPEC.md §3.10), `pause()` stops delivering messages at
 * once (frames already parsed wait, in order) and stops reading the socket, and
 * `onBufferBelow` reports when our send queue has drained.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface WebSocketOptions {
  /** Largest message (after reassembly) we accept; bigger fails the connection with 1009. */
  maxPayload: number
  /** How long we wait for the peer's close frame after sending ours before dropping the socket. */
  closeTimeoutMs?: number
  /** A slow reader that lets this many bytes pile up in our send buffer is dropped. */
  maxBufferedBytes?: number
}

export interface WebSocketHandlers {
  message(data: Buffer, isBinary: boolean): void
  /** Called exactly once. `code` is the peer's close code, or 1006 if the socket just died. */
  close(code: number, reason: string): void
}

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

function headerHasToken(value: string | undefined, token: string): boolean {
  return value !== undefined && value.split(',').some((part) => part.trim().toLowerCase() === token)
}

function rejectUpgrade(socket: Duplex, status: number, text: string, extra = ''): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`)
}

/**
 * Validates the opening handshake. Returns null (after answering the request with an
 * HTTP error) if it isn't a valid RFC 6455 upgrade.
 */
export function upgradeToWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, options: WebSocketOptions): WebSocketConnection | null {
  if (req.method !== 'GET') {
    rejectUpgrade(socket, 405, 'Method Not Allowed')
    return null
  }
  const key = req.headers['sec-websocket-key']
  if (!headerHasToken(req.headers.upgrade, 'websocket') || !headerHasToken(req.headers.connection, 'upgrade') || typeof key !== 'string') {
    rejectUpgrade(socket, 400, 'Bad Request')
    return null
  }
  if (req.headers['sec-websocket-version'] !== '13') {
    rejectUpgrade(socket, 426, 'Upgrade Required', 'Sec-WebSocket-Version: 13\r\n')
    return null
  }
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) {
    rejectUpgrade(socket, 400, 'Bad Request')
    return null
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  )
  return new WebSocketConnection(socket, head, options)
}

type State = 'open' | 'closing' | 'closed'

export class WebSocketConnection {
  readonly #socket: Duplex
  readonly #parser: FrameParser
  readonly #maxPayload: number
  readonly #closeTimeoutMs: number
  #maxBufferedBytes: number
  #handlers: WebSocketHandlers | null = null
  #state: State = 'open'
  #fragments: Buffer[] = []
  #fragmentBytes = 0
  #fragmentOpcode = 0
  #closeTimer: ReturnType<typeof setTimeout> | null = null
  #peerCode: number = CloseCode.Abnormal
  #peerReason = ''
  #pendingData: Buffer[] = []
  #closeNotified = false
  /** Set once we've failed the connection: the parser state is garbage from here on. */
  #failed = false
  #paused = false
  /** Frames parsed while paused, delivered in order on `resume`. */
  #held: Frame[] = []
  #drainWatch: { bytes: number; fn: () => void } | null = null
  readonly #afterWrite = (): void => this.#checkDrain()

  constructor(socket: Duplex, head: Buffer, options: WebSocketOptions) {
    this.#socket = socket
    this.#maxPayload = options.maxPayload
    this.#parser = new FrameParser(options.maxPayload)
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 5000
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024
    const s = socket as Duplex & { setNoDelay?: (v: boolean) => void; setTimeout?: (ms: number) => void }
    s.setNoDelay?.(true)
    s.setTimeout?.(0)
    if (head.length > 0) this.#pendingData.push(head)
    socket.on('data', (chunk: Buffer) => this.#onData(chunk))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.#onSocketClose())
    socket.on('end', () => {
      // The peer half-closed without a close frame; finish our side too.
      if (this.#state !== 'closed') socket.end()
    })
  }

  get readyState(): State {
    return this.#state
  }

  /** Bytes we've written that the OS hasn't taken yet. */
  get bufferedAmount(): number {
    return this.#socket.writableLength
  }

  /** Changes the send-queue cap; a queue already past it drops the socket. */
  setMaxBufferedBytes(bytes: number): void {
    this.#maxBufferedBytes = bytes
    if (this.#socket.writableLength > bytes) this.#socket.destroy()
  }

  /** Calls `fn` once, as soon as the send queue is at or below `bytes`. Replaces an earlier watch. */
  onBufferBelow(bytes: number, fn: () => void): void {
    this.#drainWatch = { bytes, fn }
    this.#checkDrain()
  }

  /** Stops delivering messages and reading the socket. Idempotent. */
  pause(): void {
    if (this.#paused) return
    this.#paused = true
    this.#socket.pause()
  }

  /** Delivers held frames (unless a handler pauses again), then reads the socket again. */
  resume(): void {
    if (!this.#paused) return
    this.#paused = false
    while (this.#held.length > 0 && !this.#paused) {
      const frame = this.#held.shift()!
      if (this.#failed || this.#socket.destroyed) {
        this.#held = []
        return
      }
      this.#onFrame(frame.fin, frame.opcode, frame.payload)
    }
    if (!this.#paused) this.#socket.resume()
  }

  /** Starts delivering events. Bytes that arrive before this are buffered. */
  attach(handlers: WebSocketHandlers): void {
    this.#handlers = handlers
    const pending = this.#pendingData
    this.#pendingData = []
    for (const chunk of pending) this.#onData(chunk)
    if (this.#state === 'closed') this.#notifyClose()
  }

  sendText(text: string): void {
    this.#send(Opcode.Text, Buffer.from(text, 'utf8'))
  }

  sendBinary(data: Uint8Array): void {
    this.#send(Opcode.Binary, data)
  }

  ping(payload: Uint8Array = new Uint8Array(0)): void {
    this.#send(Opcode.Ping, payload)
  }

  /** Starts the close handshake. Further sends are ignored. */
  close(code: number = CloseCode.Normal, reason = ''): void {
    if (this.#state !== 'open') return
    this.#state = 'closing'
    this.#write(encodeFrame(Opcode.Close, encodeClosePayload(code, reason)))
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), this.#closeTimeoutMs)
    this.#closeTimer.unref?.()
  }

  /** Drops the TCP connection without a close handshake. */
  terminate(): void {
    this.#socket.destroy()
  }

  #send(opcode: number, payload: Uint8Array): void {
    if (this.#state !== 'open') return
    this.#write(encodeFrame(opcode, payload))
  }

  #write(bytes: Buffer): void {
    if (this.#socket.destroyed) return
    this.#socket.write(bytes, this.#afterWrite)
    if (this.#socket.writableLength > this.#maxBufferedBytes) this.#socket.destroy()
  }

  #checkDrain(): void {
    const watch = this.#drainWatch
    if (!watch || this.#socket.writableLength > watch.bytes) return
    this.#drainWatch = null
    watch.fn()
  }

  #fail(code: number, reason: string): void {
    this.#failed = true
    if (this.#state === 'open') {
      this.#state = 'closing'
      this.#write(encodeFrame(Opcode.Close, encodeClosePayload(code, reason)))
    }
    this.#peerCode = code
    this.#peerReason = reason
    this.#socket.end()
    // Don't wait on the peer at all after a protocol failure.
    this.#closeTimer ??= setTimeout(() => this.#socket.destroy(), 1000)
    this.#closeTimer.unref?.()
  }

  #onData(chunk: Buffer): void {
    if (!this.#handlers) {
      this.#pendingData.push(chunk)
      return
    }
    if (this.#failed || this.#state === 'closed') return
    let frames
    try {
      frames = this.#parser.push(chunk)
    } catch (err) {
      if (err instanceof WebSocketProtocolError) {
        this.#fail(err.code, err.message)
        return
      }
      throw err
    }
    for (const frame of frames) {
      if (this.#failed || this.#socket.destroyed) return
      if (this.#paused) this.#held.push(frame)
      else this.#onFrame(frame.fin, frame.opcode, frame.payload)
    }
  }

  #onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case Opcode.Ping:
        this.#send(Opcode.Pong, payload)
        return
      case Opcode.Pong:
        return
      case Opcode.Close:
        this.#onCloseFrame(payload)
        return
      case Opcode.Text:
      case Opcode.Binary:
        if (this.#fragmentOpcode !== 0) return this.#fail(CloseCode.ProtocolError, 'new message inside a fragmented one')
        if (fin) return this.#deliver(opcode, payload)
        this.#fragmentOpcode = opcode
        this.#fragments = [payload]
        this.#fragmentBytes = payload.length
        return
      case Opcode.Continuation: {
        if (this.#fragmentOpcode === 0) return this.#fail(CloseCode.ProtocolError, 'continuation without a message')
        this.#fragmentBytes += payload.length
        if (this.#fragmentBytes > this.#maxPayload) return this.#fail(CloseCode.TooBig, 'message exceeds the maximum payload')
        this.#fragments.push(payload)
        if (!fin) return
        const whole = Buffer.concat(this.#fragments)
        const messageOpcode = this.#fragmentOpcode
        this.#fragments = []
        this.#fragmentBytes = 0
        this.#fragmentOpcode = 0
        this.#deliver(messageOpcode, whole)
        return
      }
    }
  }

  #deliver(opcode: number, payload: Buffer): void {
    if (this.#state !== 'open') return
    if (opcode === Opcode.Text && !isUtf8(payload)) return this.#fail(CloseCode.InvalidPayload, 'text message is not UTF-8')
    this.#handlers?.message(payload, opcode === Opcode.Binary)
  }

  #onCloseFrame(payload: Buffer): void {
    let code: number = CloseCode.NoStatus
    let reason = ''
    if (payload.length === 1) {
      this.#fail(CloseCode.ProtocolError, 'close payload of one byte')
      return
    }
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0)
      if (!isValidCloseCode(code)) {
        this.#fail(CloseCode.ProtocolError, 'invalid close code')
        return
      }
      const reasonBytes = payload.subarray(2)
      if (!isUtf8(reasonBytes)) {
        this.#fail(CloseCode.InvalidPayload, 'close reason is not UTF-8')
        return
      }
      reason = reasonBytes.toString('utf8')
    }
    if (this.#peerCode === CloseCode.Abnormal) {
      this.#peerCode = code
      this.#peerReason = reason
    }
    if (this.#state === 'open') {
      // Echo the close (RFC 6455 §5.5.1), then the server closes TCP first (§7.1.1).
      this.#state = 'closing'
      this.#write(encodeFrame(Opcode.Close, code === CloseCode.NoStatus ? Buffer.alloc(0) : encodeClosePayload(code, '')))
    }
    this.#socket.end()
    this.#closeTimer ??= setTimeout(() => this.#socket.destroy(), this.#closeTimeoutMs)
    this.#closeTimer.unref?.()
  }

  #onSocketClose(): void {
    this.#state = 'closed'
    if (this.#closeTimer) clearTimeout(this.#closeTimer)
    this.#closeTimer = null
    if (this.#handlers) this.#notifyClose()
  }

  #notifyClose(): void {
    if (this.#closeNotified) return
    this.#closeNotified = true
    this.#handlers?.close(this.#peerCode, this.#peerReason)
  }
}

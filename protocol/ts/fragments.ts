import { ProtocolError } from './errors.ts'
import type { NoiseTransport } from './noise.ts'

/**
 * §6.1: transport plaintext is either one complete JSON message (first byte `{`) or a
 * fragment of a larger one:
 *
 *   0x01 id:u32be i:u16be n:u16be chunk…   fragment i of n (0-based) of message `id`
 *
 * A sender splits anything over {@link FRAGMENT_CHUNK} bytes; the receiver puts the
 * chunks back together within the limits below and drops what breaks them, without
 * losing the session.
 */

/** First byte of a complete JSON message (`{`). */
export const PLAINTEXT_JSON = 0x7b
/** First byte of a fragment. */
export const PLAINTEXT_FRAGMENT = 0x01
/** Largest chunk, and the largest message sent whole. */
export const FRAGMENT_CHUNK = 60000
/** `0x01` + id:u32 + i:u16 + n:u16. */
export const FRAGMENT_HEADER = 9
/** Largest reassembled message. */
export const MAX_REASSEMBLED = 4 * 1024 * 1024
/** Most chunks a message within {@link MAX_REASSEMBLED} can need. */
export const MAX_FRAGMENTS = Math.ceil(MAX_REASSEMBLED / FRAGMENT_CHUNK)
/** Messages that may be partially received at once. */
export const MAX_PARTIAL_MESSAGES = 4
/** A message still missing chunks this long after its first one is dropped. */
export const PARTIAL_TIMEOUT_MS = 30_000

/**
 * The plaintexts to send for one encoded JSON message: the message itself when it fits
 * in {@link FRAGMENT_CHUNK}, else its fragments in order. `id` is the sender's
 * per-session counter (u32); it is only used when the message is split.
 */
export function fragmentMessage(json: Uint8Array, id: number): Uint8Array[] {
  if (json.length <= FRAGMENT_CHUNK) return [json]
  if (json.length > MAX_REASSEMBLED) throw new ProtocolError(`message too large (${json.length} bytes)`)
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new ProtocolError('fragment id must be a u32')
  const n = Math.ceil(json.length / FRAGMENT_CHUNK)
  const out: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const chunk = json.subarray(i * FRAGMENT_CHUNK, Math.min(json.length, (i + 1) * FRAGMENT_CHUNK))
    const frame = new Uint8Array(FRAGMENT_HEADER + chunk.length)
    const view = new DataView(frame.buffer)
    frame[0] = PLAINTEXT_FRAGMENT
    view.setUint32(1, id)
    view.setUint16(5, i)
    view.setUint16(7, n)
    frame.set(chunk, FRAGMENT_HEADER)
    out.push(frame)
  }
  return out
}

export interface ReassemblerOptions {
  /** Epoch ms; defaults to Date.now. */
  now?: () => number
  /** Why a partial message (or a stray plaintext) was dropped. */
  log?: (message: string) => void
  /**
   * Which first bytes start a complete message. Phones and desktops (§6.1) use JSON,
   * so only `{`; the desktop↔server link (protocol/SERVER.md) has binary messages of
   * its own. Never pass a test that accepts {@link PLAINTEXT_FRAGMENT}.
   */
  isWhole?: (firstByte: number) => boolean
}

interface PartialMessage {
  n: number
  chunks: (Uint8Array | undefined)[]
  received: number
  bytes: number
  startedAt: number
}

/**
 * The receiving half of §6.1, one per session and direction. `push` each decrypted
 * plaintext; it returns the complete JSON bytes when a message is whole, and null
 * while one is still partial or when the input was dropped.
 *
 * A violation — a fragment whose `n` disagrees with earlier ones, a repeated or out
 * of range `i`, an oversized chunk or message, a fifth concurrent partial message —
 * drops that message's partial state (the offending fragment included) and logs.
 */
export class Reassembler {
  readonly #partials = new Map<number, PartialMessage>()
  readonly #now: () => number
  readonly #log: (message: string) => void
  readonly #isWhole: (firstByte: number) => boolean

  constructor(options: ReassemblerOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => {})
    this.#isWhole = options.isWhole ?? ((byte) => byte === PLAINTEXT_JSON)
  }

  /** Messages currently partially received. */
  get pending(): number {
    return this.#partials.size
  }

  push(plaintext: Uint8Array): Uint8Array | null {
    this.#expire()
    if (plaintext.length === 0) {
      this.#log('fragments: empty plaintext ignored')
      return null
    }
    const first = plaintext[0]
    if (first !== PLAINTEXT_FRAGMENT && this.#isWhole(first)) return plaintext
    if (first !== PLAINTEXT_FRAGMENT) {
      this.#log(`fragments: plaintext starting 0x${first.toString(16).padStart(2, '0')} ignored`)
      return null
    }
    if (plaintext.length <= FRAGMENT_HEADER) {
      this.#log('fragments: fragment without a chunk ignored')
      return null
    }
    const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength)
    const id = view.getUint32(1)
    const i = view.getUint16(5)
    const n = view.getUint16(7)
    const chunk = plaintext.subarray(FRAGMENT_HEADER)
    const drop = (why: string): null => {
      this.#partials.delete(id)
      this.#log(`fragments: message ${id} dropped: ${why}`)
      return null
    }
    if (n < 2 || n > MAX_FRAGMENTS) return drop(`n=${n} out of range`)
    if (i >= n) return drop(`i=${i} not below n=${n}`)
    if (chunk.length > FRAGMENT_CHUNK) return drop(`chunk of ${chunk.length} bytes`)

    let partial = this.#partials.get(id)
    if (!partial) {
      if (this.#partials.size >= MAX_PARTIAL_MESSAGES) return drop(`more than ${MAX_PARTIAL_MESSAGES} partial messages`)
      partial = { n, chunks: new Array<Uint8Array | undefined>(n), received: 0, bytes: 0, startedAt: this.#now() }
      this.#partials.set(id, partial)
    }
    if (partial.n !== n) return drop(`n changed from ${partial.n} to ${n}`)
    if (partial.chunks[i]) return drop(`chunk ${i} repeated`)
    if (partial.bytes + chunk.length > MAX_REASSEMBLED) return drop('over 4 MiB')
    partial.chunks[i] = Uint8Array.from(chunk)
    partial.received++
    partial.bytes += chunk.length
    if (partial.received < n) return null

    this.#partials.delete(id)
    const out = new Uint8Array(partial.bytes)
    let offset = 0
    for (const part of partial.chunks as Uint8Array[]) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }

  /** Session reset (`0x04`) or a new handshake: forget every partial message. */
  reset(): void {
    this.#partials.clear()
  }

  #expire(): void {
    if (this.#partials.size === 0) return
    const now = this.#now()
    for (const [id, partial] of this.#partials) {
      if (now - partial.startedAt >= PARTIAL_TIMEOUT_MS) {
        this.#partials.delete(id)
        this.#log(`fragments: message ${id} dropped: incomplete after ${PARTIAL_TIMEOUT_MS / 1000} s`)
      }
    }
  }
}

/**
 * A Noise transport with §6.1 on top: every app message a desktop or phone sends goes
 * through `seal`, and every transport message received through `open`. One per session.
 */
export class FramedTransport {
  readonly transport: NoiseTransport
  readonly #reassembler: Reassembler
  #nextId = 0

  constructor(transport: NoiseTransport, options: ReassemblerOptions = {}) {
    this.transport = transport
    this.#reassembler = new Reassembler(options)
  }

  /** The Noise ciphertexts for one encoded message (JSON, or what `isWhole` accepts), in send order. */
  seal(json: Uint8Array): Uint8Array[] {
    const parts = json.length > FRAGMENT_CHUNK ? fragmentMessage(json, this.#takeId()) : [json]
    return parts.map((plaintext) => this.transport.encrypt(plaintext))
  }

  /**
   * Decrypts one transport message. Throws (ProtocolError) when it doesn't decrypt —
   * the caller answers with a reset. Returns the complete JSON bytes, or null while a
   * message is partial or when the plaintext was dropped.
   */
  open(ciphertext: Uint8Array): Uint8Array | null {
    return this.#reassembler.push(this.transport.decrypt(ciphertext))
  }

  /** Partial messages waiting for more chunks. */
  get pendingFragments(): number {
    return this.#reassembler.pending
  }

  #takeId(): number {
    const id = this.#nextId
    this.#nextId = (this.#nextId + 1) >>> 0
    return id
  }
}

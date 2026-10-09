import { MAX_REASSEMBLED, ProtocolError, b64uDecode, b64uEncode, utf8Decode, utf8Encode } from '../../../../protocol/ts/index.ts'
import { LinkError, LinkErrorCode } from './errors'

/**
 * App messages of the desktop↔server link (protocol/SERVER.md §4): one byte of
 * type, a u32 (big-endian) length, that many bytes of JSON header, and the rest of
 * the message as raw payload bytes. Every message is one transport plaintext of
 * at most 4 MiB, fragmented by `FramedTransport` above 60000 bytes.
 */
export const LinkMessageType = {
  Call: 0x10,
  Result: 0x11,
  Event: 0x12,
  Detach: 0x13,
  Open: 0x20,
  Data: 0x21,
  Credit: 0x22,
  Close: 0x23
} as const

const TYPE_NAMES: Record<number, LinkMessage['type']> = {
  [LinkMessageType.Call]: 'call',
  [LinkMessageType.Result]: 'result',
  [LinkMessageType.Event]: 'event',
  [LinkMessageType.Detach]: 'detach',
  [LinkMessageType.Open]: 'open',
  [LinkMessageType.Data]: 'data',
  [LinkMessageType.Credit]: 'credit',
  [LinkMessageType.Close]: 'close'
}

/** First bytes of a whole link message (what the reassembler lets through; 0x01 is a fragment). */
export function isLinkMessageByte(byte: number): boolean {
  return byte >= 0x10 && byte <= 0x2f
}

/** type + u32 header length. */
export const LINK_PREFIX_BYTES = 5
/** The largest message, the same 4 MiB as a reassembled one. */
export const LINK_MAX_MESSAGE = MAX_REASSEMBLED

export type StreamCloseReason = 'end' | 'error' | 'refused'

export interface CallMessage { type: 'call'; id: number; client: string; ch: string; args: unknown[]; focused?: boolean }
export type ResultMessage =
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: { code: string; message: string } }
export interface EventMessage { type: 'event'; client: string; ch: string; args: unknown[] }
export interface DetachMessage { type: 'detach'; client: string }
export interface OpenMessage { type: 'open'; sid: number; kind: string; params: unknown }
export interface DataMessage { type: 'data'; sid: number; bytes: Uint8Array }
export interface CreditMessage { type: 'credit'; sid: number; n: number }
export interface CloseMessage { type: 'close'; sid: number; reason: StreamCloseReason; message?: string }

export type LinkMessage =
  | CallMessage
  | ResultMessage
  | EventMessage
  | DetachMessage
  | OpenMessage
  | DataMessage
  | CreditMessage
  | CloseMessage

// ---- values ----------------------------------------------------------------------

/**
 * Arguments, results and event payloads are JSON with a few tagged values, so what
 * crosses the link matches what Electron's structured clone keeps: `undefined` in
 * arrays (an optional positional argument), bytes, dates and non-finite numbers.
 * A tagged value is an object whose only meaningful key is NUL. Like JSON, an
 * object property that is `undefined` is left out.
 */
const TAG = '\u0000'

function replacer(this: unknown, key: string, value: unknown): unknown {
  const raw = (this as Record<string, unknown>)[key]
  if (raw === undefined) return Array.isArray(this) || key === '' ? { [TAG]: 'u' } : undefined
  if (raw instanceof Uint8Array) return { [TAG]: 'b', d: b64uEncode(raw) }
  if (raw instanceof ArrayBuffer) return { [TAG]: 'b', d: b64uEncode(new Uint8Array(raw)) }
  if (raw instanceof Date) return { [TAG]: 'd', d: raw.getTime() }
  if (typeof raw === 'number' && !Number.isFinite(raw)) return { [TAG]: 'n', d: String(raw) }
  if (typeof raw === 'bigint') throw new LinkError(LinkErrorCode.Unsupported, 'A bigint cannot cross the host link')
  return value
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !(TAG in value)) return value
  const tagged = value as Record<string, unknown>
  switch (tagged[TAG]) {
    case 'u': return undefined
    case 'b': return typeof tagged.d === 'string' ? b64uDecode(tagged.d) : value
    case 'd': return typeof tagged.d === 'number' ? new Date(tagged.d) : value
    case 'n': return tagged.d === 'NaN' ? NaN : tagged.d === 'Infinity' ? Infinity : tagged.d === '-Infinity' ? -Infinity : value
    default: return value
  }
}

/** A value as link JSON (see {@link replacer}). */
export function encodeValue(value: unknown): string {
  return JSON.stringify(value, replacer)
}

export function decodeValue(text: string): unknown {
  return JSON.parse(text, reviver)
}

// ---- messages --------------------------------------------------------------------

function frame(type: number, header: string, payload?: Uint8Array): Uint8Array {
  const head = utf8Encode(header)
  const length = LINK_PREFIX_BYTES + head.length + (payload?.length ?? 0)
  if (length > LINK_MAX_MESSAGE) {
    throw new LinkError(LinkErrorCode.TooLarge, `The message is ${(length / (1024 * 1024)).toFixed(1)} MiB, over the host link's 4 MiB limit`)
  }
  const out = new Uint8Array(length)
  out[0] = type
  new DataView(out.buffer).setUint32(1, head.length)
  out.set(head, LINK_PREFIX_BYTES)
  if (payload) out.set(payload, LINK_PREFIX_BYTES + head.length)
  return out
}

/**
 * Splits off a final string argument: it travels as the raw payload (UTF-8) rather
 * than escaped inside the JSON, which is most of a terminal's output.
 */
function splitTail(args: unknown[]): { args: unknown[]; tail?: Uint8Array } {
  const last = args[args.length - 1]
  if (args.length === 0 || typeof last !== 'string') return { args }
  return { args: args.slice(0, -1), tail: utf8Encode(last) }
}

/** Throws LinkError(`too-large`) when the message would pass {@link LINK_MAX_MESSAGE}. */
export function encodeLinkMessage(message: LinkMessage): Uint8Array {
  switch (message.type) {
    case 'call': {
      const { args, tail } = splitTail(message.args)
      const header = `{"id":${message.id},"client":${JSON.stringify(message.client)},"ch":${JSON.stringify(message.ch)},"args":${encodeValue(args)}${message.focused ? ',"focused":true' : ''}${tail ? ',"tail":true' : ''}}`
      return frame(LinkMessageType.Call, header, tail)
    }
    case 'result':
      return frame(LinkMessageType.Result, message.ok
        ? `{"id":${message.id},"ok":true${message.value === undefined ? '' : `,"value":${encodeValue(message.value)}`}}`
        : JSON.stringify({ id: message.id, ok: false, error: { code: message.error.code, message: message.error.message } }))
    case 'event': {
      const { args, tail } = splitTail(message.args)
      const header = `{"client":${JSON.stringify(message.client)},"ch":${JSON.stringify(message.ch)},"args":${encodeValue(args)}${tail ? ',"tail":true' : ''}}`
      return frame(LinkMessageType.Event, header, tail)
    }
    case 'detach':
      return frame(LinkMessageType.Detach, JSON.stringify({ client: message.client }))
    case 'open':
      return frame(LinkMessageType.Open, `{"sid":${message.sid},"kind":${JSON.stringify(message.kind)},"params":${message.params === undefined ? 'null' : encodeValue(message.params)}}`)
    case 'data':
      return frame(LinkMessageType.Data, `{"sid":${message.sid}}`, message.bytes)
    case 'credit':
      return frame(LinkMessageType.Credit, `{"sid":${message.sid},"n":${message.n}}`)
    case 'close':
      return frame(LinkMessageType.Close, JSON.stringify({ sid: message.sid, reason: message.reason, ...(message.message ? { message: message.message } : {}) }))
  }
}

type Obj = Record<string, unknown>

function fail(message: string): never {
  throw new ProtocolError(message)
}

function uint(o: Obj, key: string, max = 0xffffffff): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) fail(`${key} must be an integer from 0 to ${max}`)
  return value
}

function str(o: Obj, key: string, maxLength = 256): string {
  const value = o[key]
  if (typeof value !== 'string' || value.length > maxLength) fail(`${key} must be a string of at most ${maxLength} characters`)
  return value
}

function argList(o: Obj, tail: Uint8Array | null): unknown[] {
  if (!Array.isArray(o.args)) fail('args must be an array')
  const args = o.args as unknown[]
  return tail ? [...args, utf8Decode(tail)] : args
}

/** Throws ProtocolError for anything malformed; the caller drops it. */
export function decodeLinkMessage(bytes: Uint8Array): LinkMessage {
  if (bytes.length < LINK_PREFIX_BYTES) fail('link message too short')
  const type = TYPE_NAMES[bytes[0]]
  if (!type) fail(`unknown link message type 0x${bytes[0].toString(16)}`)
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1)
  if (LINK_PREFIX_BYTES + headerLength > bytes.length) fail('link header runs past the message')
  let header: unknown
  try {
    header = decodeValue(utf8Decode(bytes.subarray(LINK_PREFIX_BYTES, LINK_PREFIX_BYTES + headerLength)))
  } catch (err) {
    throw new ProtocolError('link header is not JSON', { cause: err })
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) fail('link header must be an object')
  const o = header as Obj
  const payload = bytes.subarray(LINK_PREFIX_BYTES + headerLength)
  const tail = o.tail === true ? payload : null
  switch (type) {
    case 'call':
      return { type, id: uint(o, 'id'), client: str(o, 'client', 64), ch: str(o, 'ch', 128), args: argList(o, tail), ...(o.focused === true ? { focused: true } : {}) }
    case 'result': {
      const id = uint(o, 'id')
      if (o.ok === true) return { type, id, ok: true, value: o.value }
      if (o.ok !== false || typeof o.error !== 'object' || o.error === null) fail('result needs ok and, when false, error')
      const error = o.error as Obj
      return { type, id, ok: false, error: { code: str(error, 'code', 64), message: typeof error.message === 'string' ? error.message : '' } }
    }
    case 'event':
      return { type, client: str(o, 'client', 64), ch: str(o, 'ch', 128), args: argList(o, tail) }
    case 'detach':
      return { type, client: str(o, 'client', 64) }
    case 'open':
      return { type, sid: uint(o, 'sid'), kind: str(o, 'kind', 64), params: o.params ?? null }
    case 'data':
      return { type, sid: uint(o, 'sid'), bytes: payload }
    case 'credit':
      return { type, sid: uint(o, 'sid'), n: uint(o, 'n', LINK_MAX_MESSAGE * 16) }
    case 'close': {
      const reason = o.reason
      if (reason !== 'end' && reason !== 'error' && reason !== 'refused') fail('close reason must be end, error or refused')
      return { type, sid: uint(o, 'sid'), reason, ...(typeof o.message === 'string' ? { message: o.message.slice(0, 1000) } : {}) }
    }
  }
}

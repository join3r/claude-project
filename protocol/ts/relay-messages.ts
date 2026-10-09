import { b64uDecode, b64uEncode, hexDecode, hexEncode, utf8Encode } from './encoding.ts'
import { ProtocolError } from './errors.ts'
import { deviceId, ed25519Sign, ed25519Verify, isDeviceId } from './keys.ts'
import { PushLimits, type PushResult } from './push.ts'

/**
 * Relay protocol v1 (SPEC.md §3): one JSON object per WebSocket text frame,
 * discriminated by `t`. The parsers return fresh objects holding only the fields the
 * spec defines, so unknown fields from a newer peer are dropped rather than passed on.
 * After `ready`, a client that asked for it may also send and receive binary frames
 * (§3.9, `encodeRelayBinaryFrame`/`decodeRelayBinaryFrame`).
 */

export const RELAY_PATH = '/v1'
/** Largest WebSocket message a client may send, text or binary (§3.5). */
export const RELAY_MAX_FRAME_BYTES = 256 * 1024
export const RELAY_HELLO_TIMEOUT_MS = 10_000
export const RELAY_PING_INTERVAL_MS = 25_000
export const RELAY_IDLE_TIMEOUT_MS = 60_000
/** Phones (and every socket before `hello`): messages per second, then the two-strike rule (§3.5). */
export const RELAY_RATE_PER_SECOND = 50
export const RELAY_RATE_BURST = 200
/** Desktops and servers: messages per second. Over budget, the relay stops reading the socket (§3.10). */
export const RELAY_HOST_RATE_PER_SECOND = 1000
export const RELAY_HOST_RATE_BURST = 4000
/** Desktops and servers: WebSocket payload bytes per second, throttled the same way. */
export const RELAY_HOST_BYTES_PER_SECOND = 8 * 1024 * 1024
export const RELAY_HOST_BYTES_BURST = 32 * 1024 * 1024
/** A receiver with more than this queued pauses the senders writing to it (§3.10)... */
export const RELAY_BUFFER_HIGH_WATER_BYTES = 4 * 1024 * 1024
/** ...until its queue falls to this. */
export const RELAY_BUFFER_LOW_WATER_BYTES = 1024 * 1024
/** A receiver whose queue grows past its cap is disconnected: phones... */
export const RELAY_PHONE_BUFFER_CAP_BYTES = 8 * 1024 * 1024
/** ...and desktops and servers. */
export const RELAY_HOST_BUFFER_CAP_BYTES = 32 * 1024 * 1024
export const RELAY_CONNECTIONS_PER_IP_PER_MINUTE = 20
/** Binary relay frames start with the raw 16 bytes behind the peer's device ID (§3.9). */
export const RELAY_BINARY_ID_BYTES = 16

/** WebSocket close codes the relay uses (§3.1, §3.5, §3.7). */
export const RelayCloseCode = {
  /** Idle timeout, or the server is shutting down. */
  GoingAway: 1001,
  TooBig: 1009,
  Auth: 4401,
  /** A pending phone's pairing window lapsed and it has no other desktop. */
  PairingExpired: 4403,
  HelloTimeout: 4408,
  Replaced: 4409,
  Rate: 4429
} as const

/**
 * §3.8. A `server` is a headless DevTool host: toward phones it acts exactly like a
 * desktop, and desktops pair with it too. Any two different roles may pair.
 */
export type Role = 'desktop' | 'phone' | 'server'
export type PeerState = 'online' | 'offline' | 'revoked'
/**
 * `unsupported`: the relay doesn't know this message type or role (§3.11). Relays from
 * before servers answer those with `auth` (a hello) or `bad-request` instead.
 */
export type RelayErrorCode = 'auth' | 'offline' | 'forbidden' | 'rate' | 'bad-request' | 'unsupported'
/**
 * An error `code` as received. Clients keep codes a newer relay may add and treat them
 * as a generic error, so compare against the `RelayErrorCode` values you handle.
 */
export type RelayErrorCodeValue = RelayErrorCode | (string & {})

export interface ChallengeMessage { t: 'challenge'; nonce: string }
export interface HelloMessage {
  t: 'hello'
  role: Role
  pub: string
  sig: string
  /** Become pending under `to`'s live offer (§3.3, §3.8). */
  pair?: { to: string; token: string }
  /** Receive frames as binary messages (§3.9). Only `true` is kept. */
  binary?: true
}
/** `binary: true` confirms a hello's `binary`; it is absent otherwise (§3.9, §3.11). */
export interface ReadyMessage { t: 'ready'; id: string; binary?: true }
export interface OfferMessage { t: 'offer'; tokenHash: string; exp: number }
/**
 * Persist the pair with `peer` (§3.2). Desktops from before servers send `phone`
 * instead; the parser keeps whichever field arrived, and `pairTarget` reads either.
 */
export type AuthorizeMessage =
  | { t: 'authorize'; peer: string; pub: string; phone?: never }
  | { t: 'authorize'; phone: string; pub: string; peer?: never }
/** Delete the pair with `peer` (or `phone`, as for `authorize`). */
export type RevokeMessage =
  | { t: 'revoke'; peer: string; phone?: never }
  | { t: 'revoke'; phone: string; peer?: never }
/** Subscribe to presence. `desktops` holds host IDs: desktops, or servers (§3.3). */
export interface WatchMessage { t: 'watch'; desktops: string[] }
/** After `ready`: become pending under `to`'s live offer, as hello `pair` does (§3.3). */
export interface PairMessage { t: 'pair'; to: string; token: string }
/** Client → server: route `data` to `to`. */
export interface FrameOutMessage { t: 'frame'; to: string; data: string }
/** Server → client: `data` arrived from `from`. */
export interface FrameInMessage { t: 'frame'; from: string; data: string }
export interface PeerMessage { t: 'peer'; id: string; state: PeerState; lastSeen?: number }
export interface PingMessage { t: 'ping' }
export interface PongMessage { t: 'pong' }
/** §7.2 desktop → relay: hand `data` to the gateway for the phone behind `cap`. */
export interface PushMessage { t: 'push'; id: number; cap: string; data: string }
/** §7.2 relay → desktop: what became of push `id`. */
export interface PushedMessage { t: 'pushed'; id: number; result: PushResultValue }
/** A push result as received; a newer relay may add values (treat unknown ones as `error`). */
export type PushResultValue = PushResult | (string & {})
export interface ErrorMessage { t: 'error'; code: RelayErrorCodeValue; message?: string; to?: string }

/** Everything a client may send to the relay. */
export type ClientMessage =
  | HelloMessage
  | OfferMessage
  | AuthorizeMessage
  | RevokeMessage
  | WatchMessage
  | PairMessage
  | FrameOutMessage
  | PushMessage
  | PingMessage
  | PongMessage

/** Everything the relay may send to a client. */
export type ServerMessage =
  | ChallengeMessage
  | ReadyMessage
  | FrameInMessage
  | PeerMessage
  | PushedMessage
  | ErrorMessage
  | PingMessage
  | PongMessage

export type RelayMessage = ClientMessage | ServerMessage

const ROLES: readonly string[] = ['desktop', 'phone', 'server']
const PEER_STATES: readonly string[] = ['online', 'offline', 'revoked']

/**
 * What `parseClientMessage` throws for a message type, or a hello role, that this
 * version doesn't know. The relay answers it with `unsupported` (§3.11) rather than
 * `bad-request`, so a newer client can tell an old relay from its own mistake.
 */
export class UnsupportedMessageError extends ProtocolError {
  /** The hello's role, when that is what this version doesn't know. */
  readonly role: string | undefined
  constructor(message: string, role?: string) {
    super(message)
    this.name = 'UnsupportedMessageError'
    this.role = role
  }
}

type Obj = Record<string, unknown>

function fail(message: string): never {
  throw new ProtocolError(message)
}

function str(o: Obj, key: string): string {
  const value = o[key]
  if (typeof value !== 'string') fail(`${key} must be a string`)
  return value
}

function optStr(o: Obj, key: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key)
}

/** Unix seconds/ms: a non-negative safe integer. */
function int(o: Obj, key: string): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${key} must be a non-negative integer`)
  return value
}

function id(o: Obj, key: string): string {
  const value = str(o, key)
  if (!isDeviceId(value)) fail(`${key} must be a device ID`)
  return value
}

/** b64u of exactly `length` bytes, or of any non-empty length when omitted. */
function b64u(o: Obj, key: string, length?: number): string {
  const value = str(o, key)
  let bytes: Uint8Array
  try {
    bytes = b64uDecode(value)
  } catch {
    fail(`${key} must be base64url`)
  }
  if (length !== undefined ? bytes.length !== length : bytes.length === 0) {
    fail(length !== undefined ? `${key} must be ${length} bytes` : `${key} must not be empty`)
  }
  return value
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly string[]): T {
  const value = str(o, key)
  if (!allowed.includes(value)) fail(`${key} has an unknown value`)
  return value as T
}

function optBool(o: Obj, key: string): boolean | undefined {
  const value = o[key]
  if (value !== undefined && typeof value !== 'boolean') fail(`${key} must be a boolean`)
  return value as boolean | undefined
}

/** `peer`, or `phone` from desktops that predate servers: exactly one of them. */
function pairTargetField(o: Obj): { peer: string } | { phone: string } {
  if (o.peer !== undefined && o.phone !== undefined) fail('send peer or phone, not both')
  return o.peer !== undefined ? { peer: id(o, 'peer') } : { phone: id(o, 'phone') }
}

function asObject(value: unknown): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('message must be a JSON object')
  return value as Obj
}

function parseJsonObject(text: string): Obj {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new ProtocolError('message is not JSON', { cause: err })
  }
  return asObject(value)
}

function parseClientObject(o: Obj): ClientMessage {
  switch (o.t) {
    case 'hello': {
      if (typeof o.role === 'string' && !ROLES.includes(o.role)) throw new UnsupportedMessageError('unknown role', o.role)
      const msg: HelloMessage = { t: 'hello', role: oneOf<Role>(o, 'role', ROLES), pub: b64u(o, 'pub', 32), sig: b64u(o, 'sig', 64) }
      if (o.pair !== undefined) {
        const pair = asObject(o.pair)
        msg.pair = { to: id(pair, 'to'), token: b64u(pair, 'token', 32) }
      }
      if (optBool(o, 'binary')) msg.binary = true
      return msg
    }
    case 'offer':
      return { t: 'offer', tokenHash: b64u(o, 'tokenHash', 32), exp: int(o, 'exp') }
    case 'authorize': {
      const target = pairTargetField(o)
      return { t: 'authorize', ...target, pub: b64u(o, 'pub', 32) }
    }
    case 'revoke':
      return { t: 'revoke', ...pairTargetField(o) }
    case 'pair':
      return { t: 'pair', to: id(o, 'to'), token: b64u(o, 'token', 32) }
    case 'watch': {
      if (!Array.isArray(o.desktops)) fail('desktops must be an array')
      const desktops = o.desktops.map((d) => {
        if (!isDeviceId(d)) fail('desktops must hold device IDs')
        return d
      })
      return { t: 'watch', desktops }
    }
    case 'frame':
      if (o.from !== undefined) fail('client frames carry `to`, not `from`')
      return { t: 'frame', to: id(o, 'to'), data: b64u(o, 'data') }
    case 'push': {
      const cap = str(o, 'cap')
      if (cap.length === 0 || cap.length > PushLimits.capChars) fail('cap has the wrong length')
      const data = b64u(o, 'data')
      if (data.length > PushLimits.dataChars) fail('data is too long')
      return { t: 'push', id: int(o, 'id'), cap, data }
    }
    case 'ping':
      return { t: 'ping' }
    case 'pong':
      return { t: 'pong' }
    default:
      throw new UnsupportedMessageError('unknown client message type')
  }
}

function parseServerObject(o: Obj): ServerMessage | null {
  switch (o.t) {
    case 'challenge':
      return { t: 'challenge', nonce: b64u(o, 'nonce', 32) }
    case 'ready': {
      const msg: ReadyMessage = { t: 'ready', id: id(o, 'id') }
      if (optBool(o, 'binary')) msg.binary = true
      return msg
    }
    case 'frame':
      if (o.to !== undefined) fail('server frames carry `from`, not `to`')
      return { t: 'frame', from: id(o, 'from'), data: b64u(o, 'data') }
    case 'peer': {
      const peerId = id(o, 'id')
      // A state a newer relay added: ignore the message rather than guess what it means.
      if (!PEER_STATES.includes(str(o, 'state'))) return null
      const msg: PeerMessage = { t: 'peer', id: peerId, state: oneOf<PeerState>(o, 'state', PEER_STATES) }
      if (o.lastSeen !== undefined) msg.lastSeen = int(o, 'lastSeen')
      return msg
    }
    case 'pushed': {
      const result = str(o, 'result')
      if (result === '') fail('result must not be empty')
      return { t: 'pushed', id: int(o, 'id'), result }
    }
    case 'error': {
      const code = str(o, 'code')
      if (code === '') fail('code must not be empty')
      const msg: ErrorMessage = { t: 'error', code }
      const message = optStr(o, 'message')
      if (message !== undefined) msg.message = message
      if (o.to !== undefined) msg.to = id(o, 'to')
      return msg
    }
    case 'ping':
      return { t: 'ping' }
    case 'pong':
      return { t: 'pong' }
    default:
      return fail('unknown server message type')
  }
}

/**
 * What the relay uses on every incoming text frame. Throws ProtocolError (→ `bad-request`),
 * or its subclass UnsupportedMessageError for an unknown `t` or role (→ `unsupported`).
 */
export function parseClientMessage(text: string): ClientMessage {
  return parseClientObject(parseJsonObject(text))
}

/**
 * What desktops and phones use on every frame from the relay. Returns null for a
 * message to ignore: a `peer` with a state this version doesn't know (forward
 * compatibility). An unknown error `code` is kept as a string.
 */
export function parseServerMessage(text: string): ServerMessage | null {
  return parseServerObject(parseJsonObject(text))
}

/**
 * Direction-agnostic parse, for tools that log both sides. `frame` is told apart by
 * whether it carries `to` (client → server) or `from` (server → client).
 */
export function parseRelayMessage(text: string): RelayMessage | null {
  const o = parseJsonObject(text)
  switch (o.t) {
    case 'challenge':
    case 'ready':
    case 'peer':
    case 'pushed':
    case 'error':
      return parseServerObject(o)
    case 'frame':
      return o.from !== undefined ? parseServerObject(o) : parseClientObject(o)
    default:
      return parseClientObject(o)
  }
}

export function encodeRelayMessage(message: RelayMessage): string {
  return JSON.stringify(message)
}

const AUTH_CONTEXT = 'devtool-relay-v1'

/**
 * §3.1: the exact bytes signed in `hello`. `nonce` is the b64u string as received, not
 * its decoded bytes, so neither side has to agree on a decoding before verifying.
 */
export function relayAuthPayload(role: Role, nonce: string): Uint8Array {
  return utf8Encode(`${AUTH_CONTEXT}\n${role}\n${nonce}`)
}

export interface HelloInput {
  role: Role
  nonce: string
  ed25519Priv: Uint8Array
  ed25519Pub: Uint8Array
  pair?: { to: string; token: Uint8Array }
  /** Ask for binary frames (§3.9). */
  binary?: boolean
}

/** Builds a signed `hello` for the challenge `nonce`. */
export function buildHello(input: HelloInput): HelloMessage {
  const msg: HelloMessage = {
    t: 'hello',
    role: input.role,
    pub: b64uEncode(input.ed25519Pub),
    sig: b64uEncode(ed25519Sign(input.ed25519Priv, relayAuthPayload(input.role, input.nonce)))
  }
  if (input.pair) msg.pair = { to: input.pair.to, token: b64uEncode(input.pair.token) }
  if (input.binary) msg.binary = true
  return msg
}

/**
 * Relay side of §3.1: checks the signature against the nonce we issued and returns the
 * device ID to answer `ready` with, or null if the hello is not authentic.
 */
export function verifyHello(hello: HelloMessage, nonce: string): string | null {
  const pub = b64uDecode(hello.pub)
  const ok = ed25519Verify(pub, relayAuthPayload(hello.role, nonce), b64uDecode(hello.sig))
  return ok ? deviceId(pub) : null
}

/** The device an `authorize` or `revoke` is about, whichever field carried it. */
export function pairTarget(message: AuthorizeMessage | RevokeMessage): string {
  return message.peer !== undefined ? message.peer : message.phone
}

/**
 * §3.9: a binary relay frame is the 16 raw bytes behind a device ID (the destination
 * when a client sends it, the source when the relay does) followed by the envelope.
 */
export function encodeRelayBinaryFrame(peer: string, envelope: Uint8Array): Uint8Array {
  if (!isDeviceId(peer)) throw new ProtocolError('peer must be a device ID')
  if (envelope.length === 0) throw new ProtocolError('envelope must not be empty')
  const out = new Uint8Array(RELAY_BINARY_ID_BYTES + envelope.length)
  out.set(hexDecode(peer), 0)
  out.set(envelope, RELAY_BINARY_ID_BYTES)
  return out
}

/** Splits a binary relay frame. `envelope` is a view into `bytes`, not a copy. */
export function decodeRelayBinaryFrame(bytes: Uint8Array): { peer: string; envelope: Uint8Array } {
  if (bytes.length <= RELAY_BINARY_ID_BYTES) throw new ProtocolError('binary frames are a 16-byte device ID and a non-empty envelope')
  return {
    peer: hexEncode(bytes.subarray(0, RELAY_BINARY_ID_BYTES)),
    envelope: bytes.subarray(RELAY_BINARY_ID_BYTES)
  }
}

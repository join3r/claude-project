import { randomBytes } from 'crypto'
import {
  ProtocolError,
  b64uDecode,
  b64uEncode,
  constantTimeEqual,
  createInitiator,
  createResponder,
  derivePairProof,
  deriveRelayToken,
  deviceId,
  negotiateVersion,
  tokenHash,
  utf8Decode,
  utf8Encode
} from '../../../../protocol/ts/index.ts'
import type { HandshakeState, KeyPair, VersionInfo } from '../../../../protocol/ts/index.ts'
import { DEFAULT_MOBILE_RELAY_URL, isValidRelayUrl, normalizeRelayUrl } from '../../../shared/mobile'
import type { ServerHostInfo } from '../../../shared/servers'
import { parseHostInfo, type HostLinkApp, type LinkBuild } from './handshake'

/**
 * Pairing a desktop with a server (protocol/SERVER.md §7). Both flows reuse the
 * phone pairing's one-time secret, HKDF and proof (SPEC.md §2): the side that
 * minted the secret makes the relay `offer` and checks the proof; the side that
 * was handed a ticket (the install token, or a server's code) joins the offer and
 * proves the secret inside a Noise IK handshake of its own, with the prologue
 * `devtool-server-pair-v1` and the envelopes `0x05`/`0x06`. The relay sees only
 * `SHA-256(relayToken)` and can't compute the proof.
 *
 * - Token flow (install one-liner): the desktop mints an `install` ticket, the
 *   new server (bootstrap) initiates.
 * - Code flow (`devtool-server pair`): the server mints a `device` ticket, the
 *   desktop initiates.
 *
 * A pairing handshake opens no session. After `ok` the desktop starts the link's
 * own handshake (§2), as it does on every reconnect.
 */

export const PAIRING_PROLOGUE = 'devtool-server-pair-v1'

/** Envelope kinds of the pairing handshake; the link's are 0x01–0x04 (SPEC.md §4.1). */
export const PairFrame = {
  /** Noise IK message 1, from the side holding the ticket. */
  Hello: 0x05,
  /** Noise IK message 2, from the side that minted it. */
  Reply: 0x06
} as const

/** How long a ticket and its relay offer live: the relay's maximum. */
export const PAIRING_TTL_SECONDS = 15 * 60

/** The pairing handshake's own version range, apart from the link's. */
export const PAIRING_VERSION: VersionInfo = { v: 1, min: 1 }

/**
 * The bootstrap's tiny protocol (pairing, the link handshake, the `bundle` stream and
 * `server-bootstrap-done`). A desktop must keep serving every version it ever
 * accepted, since `site/server/bootstrap.mjs` and the desktop are released apart.
 */
export const BOOTSTRAP_PROTOCOL = 1

const PROLOGUE = utf8Encode(PAIRING_PROLOGUE)

// ---- tickets ---------------------------------------------------------------------------

/**
 * `install`: a desktop's invite, pasted on a new server (the token in the one-liner).
 * `device`: a server's offer, pasted into a desktop (the pairing code).
 */
export type TicketKind = 'install' | 'device'

export interface PairingTicket {
  kind: TicketKind
  /** The relay both sides use, normalized (`ws://` or `wss://`, no `/v1`). */
  relay: string
  /** The issuer's device ID: always `deviceId(ed25519Pub)`. */
  id: string
  x25519Pub: Uint8Array
  ed25519Pub: Uint8Array
  /** The 32-byte one-time secret. */
  secret: Uint8Array
  /** Unix seconds. */
  exp: number
  /** The issuer's display name. */
  name: string
  /** `install` only: the Node version the new server runs (the desktop's bundle manifest). */
  node?: string
}

const TICKET_FORMAT = 1
const KIND_BYTE: Record<TicketKind, number> = { install: 1, device: 2 }
const NODE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/
const MAX_NAME_BYTES = 64

function truncateUtf8(text: string, maxBytes: number): Uint8Array {
  let bytes = utf8Encode(text)
  if (bytes.length <= maxBytes) return bytes
  // Cut on a character boundary.
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  bytes = bytes.subarray(0, end)
  return bytes
}

/**
 * The ticket as text: base64url of a small binary record, so the one-liner stays
 * short (about 150 characters with the default relay). An install token appends
 * `.<node version>`, which `site/install` reads with plain sh to fetch Node before
 * the bootstrap runs.
 *
 *     format:u8=1  kind:u8  x25519:32  ed25519:32  secret:32  exp:u32be
 *     relayLength:u8 relay (empty = the default relay)  nameLength:u8 name
 */
export function encodeTicket(ticket: PairingTicket): string {
  if (ticket.x25519Pub.length !== 32 || ticket.ed25519Pub.length !== 32 || ticket.secret.length !== 32) {
    throw new ProtocolError('ticket keys and secret must be 32 bytes')
  }
  const relay = normalizeRelayUrl(ticket.relay)
  const relayBytes = utf8Encode(relay === DEFAULT_MOBILE_RELAY_URL ? '' : relay)
  if (relayBytes.length > 255) throw new ProtocolError('relay URL too long for a ticket')
  const nameBytes = truncateUtf8(ticket.name, MAX_NAME_BYTES)
  const out = new Uint8Array(2 + 96 + 4 + 1 + relayBytes.length + 1 + nameBytes.length)
  const view = new DataView(out.buffer)
  out[0] = TICKET_FORMAT
  out[1] = KIND_BYTE[ticket.kind]
  out.set(ticket.x25519Pub, 2)
  out.set(ticket.ed25519Pub, 34)
  out.set(ticket.secret, 66)
  view.setUint32(98, ticket.exp)
  out[102] = relayBytes.length
  out.set(relayBytes, 103)
  out[103 + relayBytes.length] = nameBytes.length
  out.set(nameBytes, 104 + relayBytes.length)
  const text = b64uEncode(out)
  if (ticket.kind === 'install') {
    if (!ticket.node || !NODE_VERSION.test(ticket.node)) throw new ProtocolError('an install token needs a Node version')
    return `${text}.${ticket.node}`
  }
  return text
}

/**
 * Validates everything that can be checked offline, as SPEC.md §2 does for the QR.
 * `expect` names the kind the caller takes, so pasting a token where a code belongs
 * says so. Expiry is a separate check ({@link isTicketExpired}).
 */
export function decodeTicket(text: string, expect?: TicketKind): PairingTicket {
  const trimmed = text.trim()
  const dot = trimmed.indexOf('.')
  const body = dot === -1 ? trimmed : trimmed.slice(0, dot)
  const node = dot === -1 ? undefined : trimmed.slice(dot + 1)
  let bytes: Uint8Array
  try {
    bytes = b64uDecode(body)
  } catch {
    throw new ProtocolError('not a DevTool pairing code')
  }
  if (bytes.length < 104 || bytes[0] !== TICKET_FORMAT) throw new ProtocolError('not a DevTool pairing code')
  const kind = bytes[1] === 1 ? 'install' : bytes[1] === 2 ? 'device' : null
  if (!kind) throw new ProtocolError('not a DevTool pairing code')
  if (expect && kind !== expect) {
    throw new ProtocolError(kind === 'install'
      ? 'This is an install token for a new server, not a pairing code'
      : 'This is a pairing code for a desktop, not an install token')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const relayLength = bytes[102]
  if (bytes.length < 104 + relayLength) throw new ProtocolError('pairing code is truncated')
  const relayText = utf8Decode(bytes.subarray(103, 103 + relayLength))
  const nameLength = bytes[103 + relayLength]
  if (bytes.length !== 104 + relayLength + nameLength) throw new ProtocolError('pairing code has the wrong length')
  const relay = relayText === '' ? DEFAULT_MOBILE_RELAY_URL : relayText
  if (!isValidRelayUrl(relay)) throw new ProtocolError('pairing code names no valid relay')
  if (kind === 'install' && (!node || !NODE_VERSION.test(node))) throw new ProtocolError('install token has no Node version')
  if (kind === 'device' && node !== undefined) throw new ProtocolError('not a DevTool pairing code')
  const ed25519Pub = bytes.slice(34, 66)
  return {
    kind,
    relay: normalizeRelayUrl(relay),
    id: deviceId(ed25519Pub),
    x25519Pub: bytes.slice(2, 34),
    ed25519Pub,
    secret: bytes.slice(66, 98),
    exp: view.getUint32(98),
    name: utf8Decode(bytes.subarray(104 + relayLength)),
    ...(node ? { node } : {})
  }
}

export function isTicketExpired(ticket: Pick<PairingTicket, 'exp'>, nowMs: number = Date.now()): boolean {
  return nowMs >= ticket.exp * 1000
}

// ---- offers (the side that minted the secret) --------------------------------------------

export type PairingRejection = 'expired' | 'used' | 'wrong-secret' | 'no-offer' | 'bad-key' | 'role'

/** Words for each refusal, for logs and the bootstrap's error line. */
export const PAIRING_REJECTION_TEXT: Record<PairingRejection, string> = {
  expired: 'the pairing code expired',
  used: 'the pairing code was already used',
  'wrong-secret': 'the pairing code does not match',
  'no-offer': 'there is no pairing offer (it was cancelled or replaced)',
  'bad-key': 'the key does not match the device the relay authenticated',
  role: 'a desktop pairs only with a server'
}

/**
 * One live offer: the secret behind a ticket, what the relay `offer` carries and the
 * proof to expect. Single use: the first correct proof consumes it. The same device
 * proving it again before `exp` (its reply got lost) is answered `ok` again.
 */
export class PairingOffer {
  readonly secret: Uint8Array
  readonly relayToken: Uint8Array
  /** b64u SHA-256(relayToken), for the relay's `offer`. */
  readonly tokenHash: string
  readonly pairProof: Uint8Array
  /** Unix seconds. */
  readonly exp: number
  private consumedBy: { id: string; x25519Pub: string } | null = null

  constructor(secret: Uint8Array, exp: number) {
    if (secret.length !== 32) throw new Error('a pairing secret is 32 bytes')
    this.secret = secret
    this.exp = exp
    this.relayToken = deriveRelayToken(secret)
    this.tokenHash = b64uEncode(tokenHash(this.relayToken))
    this.pairProof = derivePairProof(secret)
  }

  static mint(nowMs: number, ttlSeconds = PAIRING_TTL_SECONDS, random: () => Uint8Array = () => new Uint8Array(randomBytes(32))): PairingOffer {
    return new PairingOffer(random(), Math.floor(nowMs / 1000) + ttlSeconds)
  }

  get consumed(): { id: string; x25519Pub: string } | null {
    return this.consumedBy ? { ...this.consumedBy } : null
  }

  expired(nowMs: number): boolean {
    return nowMs >= this.exp * 1000
  }

  /** The relay `offer` message. */
  offerMessage(): { t: 'offer'; tokenHash: string; exp: number } {
    return { t: 'offer', tokenHash: this.tokenHash, exp: this.exp }
  }

  /** Checks a proof (constant time) and consumes the offer on success. */
  check(proof: Uint8Array, peer: { id: string; x25519Pub: string }, nowMs: number): { ok: true; again: boolean } | { ok: false; reason: PairingRejection } {
    if (this.expired(nowMs)) return { ok: false, reason: 'expired' }
    const matches = constantTimeEqual(proof, this.pairProof)
    if (this.consumedBy) {
      if (matches && this.consumedBy.id === peer.id && this.consumedBy.x25519Pub === peer.x25519Pub) return { ok: true, again: true }
      return { ok: false, reason: 'used' }
    }
    if (!matches) return { ok: false, reason: 'wrong-secret' }
    this.consumedBy = { ...peer }
    return { ok: true, again: false }
  }
}

/** Why pairing failed on the ticket holder's side: a refusal, or the relay or the other side. */
export type PairingFailure = PairingRejection | 'incompatible' | 'relay-refused' | 'relay-unreachable' | 'peer-offline' | 'timeout' | 'cancelled'

export class PairingError extends Error {
  constructor(readonly code: PairingFailure, message: string) {
    super(message)
    this.name = 'PairingError'
  }
}

// ---- the handshake -----------------------------------------------------------------------

/** Message 1's payload: the ticket holder proves the secret and says who it is. */
export interface PairingHello extends VersionInfo {
  app: HostLinkApp
  /** b64u pairProof. */
  proof: string
  /** b64u of its Ed25519 key, which must hash to the relay-authenticated sender ID. */
  ed: string
  name: string
  build: LinkBuild
  host?: ServerHostInfo
  /** A server being installed: its bootstrap protocol ({@link BOOTSTRAP_PROTOCOL}). */
  bootstrap?: number
}

export type PairingResult = 'ok' | 'rejected' | 'incompatible'

/** Message 2's payload. */
export interface PairingReply extends VersionInfo {
  app: HostLinkApp
  name: string
  build: LinkBuild
  host?: ServerHostInfo
  result: PairingResult
  reason?: PairingRejection
}

type Obj = Record<string, unknown>

function parseObject(bytes: Uint8Array): Obj {
  let value: unknown
  try {
    value = JSON.parse(utf8Decode(bytes))
  } catch (err) {
    throw new ProtocolError('pairing payload is not JSON', { cause: err })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProtocolError('pairing payload must be an object')
  return value as Obj
}

function str(o: Obj, key: string, max: number): string {
  const value = o[key]
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function parseVersion(o: Obj): VersionInfo {
  const { v, min } = o
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ProtocolError('v must be a positive integer')
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 1 || min > v) throw new ProtocolError('min must be an integer from 1 to v')
  return { v, min }
}

function parseBuild(value: unknown): LinkBuild {
  const b = typeof value === 'object' && value !== null ? (value as Obj) : {}
  return { version: str(b, 'version', 64), commit: str(b, 'commit', 64), builtAt: str(b, 'builtAt', 64), bundleSha: str(b, 'bundleSha', 128) }
}

function parseApp(o: Obj): HostLinkApp {
  const app = o.app
  if (app !== 'devtool-desktop' && app !== 'devtool-server') throw new ProtocolError('app must be devtool-desktop or devtool-server')
  return app
}

export function parsePairingHello(bytes: Uint8Array): PairingHello {
  const o = parseObject(bytes)
  const host = parseHostInfo(o.host)
  const bootstrap = o.bootstrap
  return {
    ...parseVersion(o),
    app: parseApp(o),
    proof: str(o, 'proof', 64),
    ed: str(o, 'ed', 64),
    name: str(o, 'name', 100),
    build: parseBuild(o.build),
    ...(host ? { host } : {}),
    ...(typeof bootstrap === 'number' && Number.isInteger(bootstrap) && bootstrap > 0 ? { bootstrap } : {})
  }
}

const RESULTS: readonly string[] = ['ok', 'rejected', 'incompatible']
const REASONS: readonly string[] = Object.keys(PAIRING_REJECTION_TEXT)

export function parsePairingReply(bytes: Uint8Array): PairingReply {
  const o = parseObject(bytes)
  const result = o.result
  if (typeof result !== 'string' || !RESULTS.includes(result)) throw new ProtocolError('result has an unknown value')
  let version: VersionInfo
  try {
    version = parseVersion(o)
  } catch (err) {
    if (result !== 'incompatible') throw err
    version = { v: 0, min: 0 }
  }
  const host = parseHostInfo(o.host)
  const reason = typeof o.reason === 'string' && REASONS.includes(o.reason) ? (o.reason as PairingRejection) : undefined
  return {
    ...version,
    app: o.app === 'devtool-desktop' ? 'devtool-desktop' : 'devtool-server',
    name: str(o, 'name', 100),
    build: parseBuild(o.build),
    result: result as PairingResult,
    ...(host ? { host } : {}),
    ...(reason ? { reason } : {})
  }
}

function envelope(kind: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length)
  out[0] = kind
  out.set(body, 1)
  return out
}

/** True for a pairing envelope (`0x05` or `0x06`). */
export function isPairingEnvelope(data: Uint8Array): boolean {
  return data.length > 1 && (data[0] === PairFrame.Hello || data[0] === PairFrame.Reply)
}

/** The ticket holder's side: it knows the minter's static key from the ticket. */
export class PairingInitiator {
  private readonly handshake: HandshakeState

  constructor(staticKey: KeyPair, remoteStatic: Uint8Array) {
    this.handshake = createInitiator({ prologue: PROLOGUE, s: staticKey, rs: remoteStatic })
  }

  /** Envelope `0x05`. */
  start(hello: PairingHello): Uint8Array {
    return envelope(PairFrame.Hello, this.handshake.writeMessage(utf8Encode(JSON.stringify(hello))))
  }

  /** The body of a `0x06` envelope. Throws ProtocolError when it doesn't decrypt or parse. */
  finish(body: Uint8Array): PairingReply {
    return parsePairingReply(this.handshake.readMessage(body))
  }
}

export interface PairingDecision {
  hello: PairingHello
  /** The initiator's Noise static key (message 1 reveals it). */
  remoteStatic: Uint8Array
}

export interface PairingOutcome {
  /** Envelope `0x06` to send back. */
  envelope: Uint8Array
  result: PairingResult
  reason?: PairingRejection
  /** Null when the versions didn't match (the payload may have another shape). */
  hello: PairingHello | null
  remoteStatic: Uint8Array
}

/**
 * The minter's side: reads message 1 (the body of a `0x05` envelope), negotiates the
 * version, checks that `ed` is the relay-authenticated sender, lets `decide` check
 * the proof, and writes message 2. `expectApp` is the other side's app. Throws ProtocolError when message 1 doesn't
 * decrypt or parse; the caller drops it without a reply.
 */
export function answerPairing(
  staticKey: KeyPair,
  body: Uint8Array,
  from: string,
  expectApp: HostLinkApp,
  reply: () => Omit<PairingReply, 'result' | 'reason' | 'v' | 'min'>,
  decide: (decision: PairingDecision) => { result: 'ok' } | { result: 'rejected'; reason: PairingRejection },
  local: VersionInfo = PAIRING_VERSION
): PairingOutcome {
  const handshake = createResponder({ prologue: PROLOGUE, s: staticKey })
  const payload = handshake.readMessage(body)
  const remoteStatic = handshake.remoteStatic!
  const o = parseObject(payload)
  const negotiation = negotiateVersion(local, parseVersion(o))
  let result: PairingResult
  let reason: PairingRejection | undefined
  let hello: PairingHello | null = null
  if (!negotiation.ok) {
    result = 'incompatible'
  } else {
    hello = parsePairingHello(payload)
    let ed: Uint8Array | null
    try {
      ed = b64uDecode(hello.ed)
    } catch {
      ed = null
    }
    if (hello.app !== expectApp) {
      result = 'rejected'
      reason = 'role'
    } else if (!ed || ed.length !== 32 || deviceId(ed) !== from) {
      result = 'rejected'
      reason = 'bad-key'
    } else {
      const decision = decide({ hello, remoteStatic })
      result = decision.result
      if (decision.result === 'rejected') reason = decision.reason
    }
  }
  const message: PairingReply = { v: local.v, min: local.min, ...reply(), result, ...(reason ? { reason } : {}) }
  return {
    envelope: envelope(PairFrame.Reply, handshake.writeMessage(utf8Encode(JSON.stringify(message)))),
    result,
    ...(reason ? { reason } : {}),
    hello,
    remoteStatic
  }
}

/** The proof a hello carries, or null when it isn't 32 bytes of b64u. */
export function helloProof(hello: PairingHello): Uint8Array | null {
  try {
    const proof = b64uDecode(hello.proof)
    return proof.length === 32 ? proof : null
  } catch {
    return null
  }
}

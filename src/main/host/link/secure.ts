import {
  FrameKind,
  FramedTransport,
  ProtocolError,
  createInitiator,
  createResponder,
  encodeEnvelope,
  negotiateVersion,
  utf8Encode
} from '../../../../protocol/ts/index.ts'
import type { HandshakeState, KeyPair, VersionInfo } from '../../../../protocol/ts/index.ts'
import {
  HOST_LINK_PROLOGUE,
  encodeHandshakePayload,
  parseHandshakeVersion,
  parseHello,
  parseReply,
  type HostLinkHello,
  type HostLinkReply,
  type HostLinkResult
} from './handshake'
import { isLinkMessageByte } from './wire'
import { HOST_LINK_MIN_VERSION, HOST_LINK_PROTOCOL_VERSION } from './version'

/**
 * The Noise half of the desktop↔server link (protocol/SERVER.md §2): the §4.1
 * envelopes of the phone channel, Noise IK with the prologue `devtool-server-v1`,
 * the desktop as initiator, and §6.1 fragmentation for messages over 60000 bytes.
 */

const PROLOGUE = utf8Encode(HOST_LINK_PROLOGUE)
const LOCAL_VERSION: VersionInfo = { v: HOST_LINK_PROTOCOL_VERSION, min: HOST_LINK_MIN_VERSION }

/** One side's sealed session: link messages in, envelopes out, and back. */
export class SealedChannel {
  private readonly framed: FramedTransport

  constructor(framed: FramedTransport) {
    this.framed = framed
  }

  /** The envelopes (`0x03` + ciphertext) for one link message, in order. */
  seal(plaintext: Uint8Array): Uint8Array[] {
    return this.framed.seal(plaintext).map((body) => encodeEnvelope(FrameKind.Transport, body))
  }

  /**
   * One transport body: the whole message once complete, else null. Throws
   * ProtocolError when it doesn't decrypt (the caller resets the session).
   */
  open(body: Uint8Array): Uint8Array | null {
    return this.framed.open(body)
  }
}

function sealed(handshake: HandshakeState, log: (message: string) => void): SealedChannel {
  return new SealedChannel(new FramedTransport(handshake.split(), { log, isWhole: isLinkMessageByte }))
}

/** The desktop's side of one handshake attempt. */
export class LinkInitiator {
  private readonly handshake: HandshakeState

  constructor(staticKey: KeyPair, serverStatic: Uint8Array, private readonly log: (message: string) => void) {
    this.handshake = createInitiator({ prologue: PROLOGUE, s: staticKey, rs: serverStatic })
  }

  /** Envelope `0x01`: message 1 carrying the desktop's hello. */
  start(hello: HostLinkHello): Uint8Array {
    return encodeEnvelope(FrameKind.Handshake1, this.handshake.writeMessage(encodeHandshakePayload(hello)))
  }

  /**
   * Message 2's body. Throws ProtocolError when it doesn't decrypt or parse. With
   * `ok`, `channel` is the session; with anything else there is none.
   */
  finish(body: Uint8Array): { reply: HostLinkReply; channel: SealedChannel | null } {
    const payload = this.handshake.readMessage(body)
    const reply = parseReply(payload)
    if (reply.result !== 'ok') return { reply, channel: null }
    if (reply.app !== 'devtool-server') throw new ProtocolError('the peer is not a DevTool server')
    return { reply, channel: sealed(this.handshake, this.log) }
  }
}

export interface ResponderDecision {
  /** The desktop's hello, or null when its version can't be negotiated (the payload may have another shape). */
  hello: HostLinkHello | null
  /** The desktop's Noise static key, as message 1 revealed it. */
  remoteStatic: Uint8Array
}

export interface ResponderOutcome {
  /** Envelope `0x02` to send back. */
  envelope: Uint8Array
  result: HostLinkResult
  hello: HostLinkHello | null
  remoteStatic: Uint8Array
  /** With `ok` only. */
  channel: SealedChannel | null
  /** With `incompatible`: whose version is too old. */
  update?: 'desktop' | 'server'
}

/**
 * Whether a Noise message 1 (the envelope's body) was written for the link, not
 * for a phone's channel: only the link's prologue opens it. A server tells an
 * unknown desktop's handshake from a phone's this way (protocol/SERVER.md §3),
 * since nothing in message 1 is readable before that.
 */
export function isLinkHandshake(staticKey: KeyPair, body: Uint8Array): boolean {
  try {
    createResponder({ prologue: PROLOGUE, s: staticKey }).readMessage(body)
    return true
  } catch {
    return false
  }
}

/**
 * The server's side: reads message 1, lets `decide` check the desktop's static key
 * (the version is negotiated here first), and writes message 2. Throws ProtocolError
 * when message 1 doesn't decrypt or parse; the caller drops it without replying
 * (a desktop holding the wrong server key would otherwise loop, SPEC.md §4.3).
 */
export function answerHandshake(
  staticKey: KeyPair,
  body: Uint8Array,
  reply: (result: HostLinkResult) => Omit<HostLinkReply, 'result'>,
  decide: (decision: ResponderDecision) => 'ok' | 'unknown-device',
  log: (message: string) => void,
  local: VersionInfo = LOCAL_VERSION
): ResponderOutcome {
  const handshake = createResponder({ prologue: PROLOGUE, s: staticKey })
  const payload = handshake.readMessage(body)
  const remoteStatic = handshake.remoteStatic!
  const negotiation = negotiateVersion(local, parseHandshakeVersion(payload))
  let result: HostLinkResult
  let hello: HostLinkHello | null = null
  let update: 'desktop' | 'server' | undefined
  if (!negotiation.ok) {
    result = 'incompatible'
    update = negotiation.update === 'remote' ? 'desktop' : 'server'
  } else {
    hello = parseHello(payload)
    if (hello.app !== 'devtool-desktop') throw new ProtocolError('the peer is not a DevTool desktop')
    result = decide({ hello, remoteStatic })
  }
  const envelope = encodeEnvelope(FrameKind.Handshake2, handshake.writeMessage(encodeHandshakePayload({ ...reply(result), result })))
  return { envelope, result, hello, remoteStatic, channel: result === 'ok' ? sealed(handshake, log) : null, ...(update ? { update } : {}) }
}

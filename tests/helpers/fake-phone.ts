import {
  DEVTOOL_NOISE_PROLOGUE,
  FrameKind,
  FramedTransport,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  b64uDecode,
  createInitiator,
  decodeEnvelope,
  derivePairProof,
  deviceId,
  encodeEnvelope,
  encodeJson,
  generateEd25519,
  generateX25519,
  parseAppMessage,
  parseDesktopHello,
  b64uEncode,
  utf8Encode
} from '../../protocol/ts/index.ts'
import type { AppMessage, DesktopHello, HandshakeState, KeyPair, PhoneHello } from '../../protocol/ts/index.ts'

/**
 * A phone built only from protocol/ts: the Noise initiator side of SPEC.md §4.
 * Transport-agnostic — feed it envelopes with `receive` and collect what it
 * wants to send from `outbox`.
 */
export class FakePhone {
  readonly x: KeyPair = generateX25519()
  readonly ed: KeyPair = generateEd25519()
  readonly id = deviceId(this.ed.pub)
  transport: FramedTransport | null = null
  /** Transport frames received (a fragmented message counts once per fragment). */
  transportFrames = 0
  desktopHello: DesktopHello | null = null
  readonly messages: AppMessage[] = []
  readonly resets: number[] = []
  /** Envelopes to deliver to the desktop. */
  readonly outbox: Uint8Array[] = []
  readonly name: string
  private handshake: HandshakeState | null = null
  private readonly desktopX25519Pub: Uint8Array

  // No parameter properties: this file also runs under Node's type stripping.
  constructor(desktopX25519Pub: Uint8Array, name = 'Test iPhone') {
    this.desktopX25519Pub = desktopX25519Pub
    this.name = name
  }

  hello(kind: 'pair' | 'resume', secret?: Uint8Array): PhoneHello {
    return {
      v: PROTOCOL_VERSION, min: MIN_PROTOCOL_VERSION, app: 'ios/test', features: [], kind, deviceName: this.name, ed: b64uEncode(this.ed.pub),
      ...(kind === 'pair' && secret ? { proof: b64uEncode(derivePairProof(secret)) } : {})
    }
  }

  /** Queue message 1 with `payload` (anything encodeJson takes, or raw bytes). */
  startHandshake(payload: PhoneHello | Uint8Array): Uint8Array {
    this.transport = null
    this.desktopHello = null
    this.handshake = createInitiator({ prologue: utf8Encode(DEVTOOL_NOISE_PROLOGUE), s: this.x, rs: this.desktopX25519Pub })
    const body = payload instanceof Uint8Array ? payload : encodeJson(payload)
    const envelope = encodeEnvelope(FrameKind.Handshake1, this.handshake.writeMessage(body))
    this.outbox.push(envelope)
    return envelope
  }

  request(id: number, op: string, params?: unknown): Uint8Array[] {
    if (!this.transport) throw new Error('no session')
    const req = params === undefined ? { t: 'req' as const, id, op } : { t: 'req' as const, id, op, params }
    const envelopes = this.transport.seal(encodeJson(req)).map((body) => encodeEnvelope(FrameKind.Transport, body))
    this.outbox.push(...envelopes)
    return envelopes
  }

  receive(data: Uint8Array): void {
    const { kind, body } = decodeEnvelope(data)
    if (kind === FrameKind.Handshake2) {
      if (!this.handshake) throw new Error('unexpected message 2')
      this.desktopHello = parseDesktopHello(this.handshake.readMessage(body))
      if (this.desktopHello.result === 'ok' || this.desktopHello.result === 'pending') this.transport = new FramedTransport(this.handshake.split())
      this.handshake = null
      return
    }
    if (kind === FrameKind.Transport) {
      if (!this.transport) throw new Error('transport without session')
      this.transportFrames++
      const plaintext = this.transport.open(body)
      if (!plaintext) return
      const message = parseAppMessage(plaintext)
      if (message) this.messages.push(message)
      return
    }
    if (kind === FrameKind.Reset) {
      this.resets.push(this.messages.length)
      this.transport = null
    }
  }

  receiveB64(data: string): void {
    this.receive(b64uDecode(data))
  }
}

import {
  DEVTOOL_NOISE_PROLOGUE,
  FrameKind,
  FramedTransport,
  MAX_REASSEMBLED,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  ProtocolError,
  createResponder,
  decodeEnvelope,
  encodeEnvelope,
  encodeJson,
  negotiateVersion,
  parseAppMessage,
  parseHelloVersion,
  parsePhoneHello,
  utf8Encode
} from '../../../protocol/ts/index.ts'
import type { DesktopHello, HandshakeResult, KeyPair } from '../../../protocol/ts/index.ts'
import type { ChannelFactory, ChannelHooks, DesktopAppMessage, PhoneChannel } from './mobile-service'

export interface NoiseChannelOptions {
  /** This desktop's Noise static keypair (read lazily: the identity loads on first use). */
  staticKey: () => KeyPair
  /** e.g. `devtool/0.3.2`. */
  app: string
  desktopName: () => string
  /** Optional ops this desktop answers (SPEC.md §8.1), sent in its hello. */
  features?: () => string[]
  log: (message: string) => void
}

/**
 * The desktop end of one phone's channel (SPEC.md §4): a Noise IK responder that
 * turns envelopes into app messages. Each message 1 starts a fresh session.
 */
class NoisePhoneChannel implements PhoneChannel {
  private transport: FramedTransport | null = null
  private closed = false

  constructor(
    private readonly phoneId: string,
    private readonly hooks: ChannelHooks,
    private readonly options: NoiseChannelOptions
  ) {}

  get established(): boolean {
    return this.transport !== null && !this.closed
  }

  receive(data: Uint8Array): void {
    if (this.closed) return
    let envelope
    try {
      envelope = decodeEnvelope(data)
    } catch {
      this.sendEnvelope(FrameKind.Reset)
      return
    }
    switch (envelope.kind) {
      case FrameKind.Handshake1:
        this.handshake(envelope.body)
        return
      case FrameKind.Transport:
        this.transportMessage(envelope.body)
        return
      case FrameKind.Reset:
        // The phone has no session; it will start a new handshake.
        this.loseSession()
        return
      case FrameKind.Handshake2:
        // Only the desktop sends message 2.
        return
    }
  }

  send(message: DesktopAppMessage): boolean {
    if (!this.transport || this.closed) return false
    const plaintext = encodeJson(message)
    // Anything over 60000 bytes goes out as fragments (SPEC.md §6.1), up to 4 MiB.
    if (plaintext.length > MAX_REASSEMBLED) {
      this.options.log(`mobileChannel phone=${this.phoneId} message too large (${plaintext.length} bytes)`)
      return false
    }
    try {
      for (const body of this.transport.seal(plaintext)) this.sendEnvelope(FrameKind.Transport, body)
      return true
    } catch (err) {
      this.options.log(`mobileChannel phone=${this.phoneId} encrypt failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  close(): void {
    this.closed = true
    this.transport = null
  }

  private handshake(message: Uint8Array): void {
    // A new message 1 always replaces the old session (§4.2).
    if (this.transport) this.loseSession()
    const responder = createResponder({ prologue: utf8Encode(DEVTOOL_NOISE_PROLOGUE), s: this.options.staticKey() })
    let payload: Uint8Array
    try {
      payload = responder.readMessage(message)
    } catch (err) {
      // Dropped silently (§4.3): a phone holding the wrong desktop key would loop on a reset.
      this.options.log(`mobileChannel phone=${this.phoneId} message 1 unreadable: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    let result: HandshakeResult
    try {
      const negotiation = negotiateVersion({ v: PROTOCOL_VERSION, min: MIN_PROTOCOL_VERSION }, parseHelloVersion(payload))
      if (negotiation.ok) {
        result = this.hooks.onHello({ hello: parsePhoneHello(payload), remoteStatic: responder.remoteStatic! })
      } else {
        // `remote`: the phone runs an older app ("Update DevTool on your iPhone").
        this.hooks.onIncompatible?.({ update: negotiation.update === 'remote' ? 'phone' : 'desktop', deviceName: helloDeviceName(payload) })
        result = 'incompatible'
      }
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      this.options.log(`mobileChannel phone=${this.phoneId} bad hello: ${err.message}`)
      result = 'rejected'
    }

    const reply: DesktopHello = {
      v: PROTOCOL_VERSION,
      min: MIN_PROTOCOL_VERSION,
      app: this.options.app,
      features: this.options.features?.() ?? [],
      desktopName: this.options.desktopName(),
      result
    }
    this.sendEnvelope(FrameKind.Handshake2, responder.writeMessage(encodeJson(reply)))
    // Only ok and pending establish a session (§4.3).
    if (result !== 'ok' && result !== 'pending') return
    this.transport = new FramedTransport(responder.split(), {
      log: (line) => this.options.log(`mobileChannel phone=${this.phoneId} ${line}`)
    })
    this.hooks.onEstablished(result)
  }

  private transportMessage(body: Uint8Array): void {
    if (!this.transport) {
      this.sendEnvelope(FrameKind.Reset)
      return
    }
    let plaintext: Uint8Array | null
    try {
      plaintext = this.transport.open(body)
    } catch {
      // Counters are out of step; only a new handshake fixes that.
      this.loseSession()
      this.sendEnvelope(FrameKind.Reset)
      return
    }
    // A fragment of a message still being reassembled, or plaintext we ignore (§6.1).
    if (!plaintext) return
    let message
    try {
      message = parseAppMessage(plaintext)
    } catch (err) {
      this.options.log(`mobileChannel phone=${this.phoneId} bad app message: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (message) this.hooks.onAppMessage(message)
  }

  private loseSession(): void {
    if (!this.transport) return
    this.transport = null
    this.hooks.onSessionLost()
  }

  private sendEnvelope(kind: FrameKind, body?: Uint8Array): void {
    this.hooks.sendFrame(encodeEnvelope(kind, body))
  }
}

/** The phone's name from a hello this desktop can't otherwise parse (another version's shape). */
function helloDeviceName(payload: Uint8Array): string | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(payload))
    const name = typeof value === 'object' && value !== null ? (value as { deviceName?: unknown }).deviceName : undefined
    return typeof name === 'string' && name.length > 0 ? name.slice(0, 100) : undefined
  } catch {
    return undefined
  }
}

export function createNoiseChannelFactory(options: NoiseChannelOptions): ChannelFactory {
  return { create: (phoneId, hooks) => new NoisePhoneChannel(phoneId, hooks, options) }
}

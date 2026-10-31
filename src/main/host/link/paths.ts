import type { DirectPipe } from './direct'
import { LINK_HIGH_WATER_BYTES, LINK_LOW_WATER_BYTES } from './relay-transport'
import type { SealedChannel } from './secure'
import type { LinkTransport } from './session'
import { FrameKind, decodeEnvelope } from '../../../../protocol/ts/index.ts'

/**
 * `path {to: "direct"}` (protocol/SERVER.md §13.5): the last message a side sends
 * over the relay. Everything after it goes over the direct pipe.
 */
export const PATH_MESSAGE_TYPE = 0x14
const PATH_TO_DIRECT = new Uint8Array([PATH_MESSAGE_TYPE, 0, 0, 0, 15, ...new TextEncoder().encode('{"to":"direct"}')])
/** Direct messages that may wait for the relay's `path` marker before the session is given up. */
const MAX_EARLY_BYTES = 16 * 1024 * 1024

/**
 * One session's two paths: the relay it starts on, and the direct pipe it moves
 * to. Each direction moves on its own: a side sends `path` as its last relay
 * message and then only uses the pipe, and the receiver holds what the pipe
 * brings until that marker has come through the relay. So the session sees every
 * message once, in the order it was sent, across the move.
 */
export class LinkPaths implements LinkTransport {
  private direct: LinkTransport | null = null
  /** The peer said `path`: what the pipe brings goes straight to the session. */
  private receivingDirect = false
  private early: Uint8Array[] = []
  private earlyBytes = 0

  constructor(
    private readonly relay: LinkTransport,
    private readonly deliver: (plaintext: Uint8Array) => void,
    private readonly fail: (why: string) => void
  ) {}

  /** This side sends over the direct pipe. */
  get sendingDirect(): boolean {
    return this.direct !== null
  }

  /** Either direction has moved: losing the pipe now loses messages, so it ends the session. */
  get onDirect(): boolean {
    return this.direct !== null || this.receivingDirect
  }

  send(plaintext: Uint8Array): boolean {
    return (this.direct ?? this.relay).send(plaintext)
  }

  congested(): boolean {
    return (this.direct ?? this.relay).congested()
  }

  whenDrained(fn: () => void): void {
    ;(this.direct ?? this.relay).whenDrained(fn)
  }

  /** Moves sending to `direct`. False when the marker couldn't go out (the relay is gone). */
  useDirect(direct: LinkTransport): boolean {
    if (this.direct) return true
    if (!this.relay.send(PATH_TO_DIRECT)) return false
    this.direct = direct
    return true
  }

  /** A whole link message that came through the relay. */
  fromRelay(plaintext: Uint8Array): void {
    if (plaintext.length > 0 && plaintext[0] === PATH_MESSAGE_TYPE) {
      this.receivingDirect = true
      const early = this.early
      this.early = []
      this.earlyBytes = 0
      for (const message of early) this.deliver(message)
      return
    }
    this.deliver(plaintext)
  }

  /** A whole link message that came through the direct pipe. */
  fromDirect(plaintext: Uint8Array): void {
    if (this.receivingDirect) {
      this.deliver(plaintext)
      return
    }
    this.earlyBytes += plaintext.length
    if (this.earlyBytes > MAX_EARLY_BYTES) {
      this.fail('the relay never said the peer moved to the direct path')
      return
    }
    this.early.push(plaintext)
  }
}

/** The link's transport over a direct pipe, sealed by the pipe's own Noise session. */
export function pipeLinkTransport(pipe: DirectPipe, channel: SealedChannel): LinkTransport {
  return {
    send: (plaintext) => {
      for (const envelope of channel.seal(plaintext)) {
        if (!pipe.send(envelope)) return false
      }
      return true
    },
    congested: () => pipe.bufferedAmount() > LINK_HIGH_WATER_BYTES,
    whenDrained: (fn) => pipe.whenBelow(LINK_LOW_WATER_BYTES, fn)
  }
}

/**
 * Reads transport envelopes off a pipe whose handshake is done: each opened
 * message goes to `onMessage`; anything else (a bad envelope, one that doesn't
 * decrypt, a reset) ends the pipe through `onBroken`.
 */
export function readPipe(pipe: DirectPipe, channel: SealedChannel, onMessage: (plaintext: Uint8Array) => void, onBroken: (why: string) => void): void {
  pipe.onMessage((bytes) => {
    let plaintext: Uint8Array | null
    try {
      const envelope = decodeEnvelope(bytes)
      if (envelope.kind === FrameKind.Reset) {
        onBroken('the peer reset the direct path')
        return
      }
      if (envelope.kind !== FrameKind.Transport) return
      plaintext = channel.open(envelope.body)
    } catch {
      onBroken('an undecryptable message on the direct path')
      return
    }
    if (plaintext) onMessage(plaintext)
  })
}

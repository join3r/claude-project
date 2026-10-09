import { randomBytes } from 'crypto'
import {
  FrameKind,
  b64uDecode,
  b64uEncode,
  decodeEnvelope,
  deriveRelayToken,
  deviceId,
  encodeEnvelope,
  tokenHash
} from '../../protocol/ts/index.ts'
import type { Envelope, ErrorMessage, PeerMessage, VersionInfo } from '../../protocol/ts/index.ts'
import type { DesktopIdentity } from '../main/mobile/identity'
import type { RelayTransportState } from '../main/mobile/mobile-service'
import { encodeDevPairCode, type DevKeys } from '../main/host/link/dev-pair'
import { diagnosticStreamKinds } from '../main/host/link/diagnostic-streams'
import { LinkError, LinkErrorCode, errorMessage } from '../main/host/link/errors'
import { buildHello, type HostLinkHello, type LinkBuild } from '../main/host/link/handshake'
import { PeerStore } from '../main/host/link/peer-store'
import type { HostLinkPort, RelayMux } from '../main/host/link/relay-mux'
import { relayLinkTransport } from '../main/host/link/relay-transport'
import { answerHandshake, type SealedChannel } from '../main/host/link/secure'
import { LinkSession, type IncomingCall, type LinkTimers } from '../main/host/link/session'
import type { StreamKinds } from '../main/host/link/stream'
import { HOST_LINK_MIN_VERSION, HOST_LINK_PROTOCOL_VERSION } from '../main/host/link/version'
import type { ClientRegistry } from './client-registry'

/** Terminal output batching on the server (plan: at most one message per tab and client per 16 ms). */
export const PTY_COALESCE_MS = 16
/** Characters of terminal output in one message: at most 48 KiB of UTF-8, so one Noise message. */
export const PTY_MESSAGE_CHARS = 16 * 1024
/** Channels a linked desktop may not call: `scrollback-save-sync` blocks a local window only. */
const LOCAL_ONLY_CHANNELS = new Set(['scrollback-save-sync'])
/** A desktop's own client ids (`win:3`). */
const CLIENT_ID = /^[A-Za-z0-9._-]{1,24}(:[A-Za-z0-9._-]{1,24})?$/
/** How long a dev pairing's relay offer lasts (the relay's maximum). */
const DEV_OFFER_SECONDS = 15 * 60

/** The host's terminal flow control (HostServices). */
export interface TerminalFlow {
  holdTerminalOutput(tabId: string, holder: string): boolean
  releaseTerminalOutput(tabId: string, holder: string): void
  terminalOutputHeldBy(holder: string): string[]
}

export interface ServerLinkOptions {
  relay: RelayMux
  identity: { get(): DesktopIdentity }
  registry: ClientRegistry
  terminals: TerminalFlow
  /** The server's data dir: the paired desktops live in `desktops.json`. */
  dataDir: string
  relayUrl: () => string
  name: () => string
  build: LinkBuild
  log: (message: string) => void
  /** Stream kinds desktops may open; by default the diagnostic ones (`echo`, `sink`, `source`). */
  streams?: StreamKinds
  /**
   * Peers that are phones, which the mobile service answers. Everything else is
   * taken to be a desktop, so one the server doesn't know hears `unknown-device`.
   * (The server's phones arrive with step 10; until then there are none.)
   */
  isPhone?: (peerId: string) => boolean
  /** Tests: speak another protocol version range. */
  version?: VersionInfo
  timers?: LinkTimers
}

/** Counters for tests and the live check. */
export interface ServerLinkStats {
  /** Times a congested link held a terminal's output back. */
  holds: number
  /** Times it let them go again. */
  releases: number
}

/**
 * The server's end of the host link: the Noise responder for every paired desktop
 * on the relay socket the phones would use too, one {@link DesktopLink} per
 * connected desktop, and the dev pairing offer.
 */
export class ServerLink {
  readonly desktops: PeerStore
  readonly stats: ServerLinkStats = { holds: 0, releases: 0 }
  private readonly port: HostLinkPort
  private readonly links = new Map<string, DesktopLink>()
  /** Dev pairings waiting for their desktop on the relay: id → offer. */
  private readonly devOffers = new Map<string, { tokenHash: string; exp: number }>()
  private readonly onlineWaiters: (() => void)[] = []
  private readonly streams: StreamKinds
  private readonly version: VersionInfo
  private started = false

  constructor(private readonly options: ServerLinkOptions) {
    this.desktops = new PeerStore(options.dataDir, 'desktops.json', options.log)
    this.streams = options.streams ?? diagnosticStreamKinds()
    this.version = options.version ?? { v: HOST_LINK_PROTOCOL_VERSION, min: HOST_LINK_MIN_VERSION }
    const isPhone = options.isPhone ?? (() => false)
    this.port = options.relay.hostPort((peerId) => this.desktops.has(peerId) || !isPhone(peerId), {
      frame: (from, envelope) => this.onFrame(from, envelope),
      peer: (message) => this.onPeer(message),
      error: (message) => this.onRelayError(message)
    })
    this.port.onStateChange((state) => this.onRelayState(state))
  }

  /** Connects to the relay and serves the paired desktops from then on. */
  start(): void {
    if (this.started) return
    this.started = true
    this.port.connect(this.options.relayUrl())
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    for (const desktopId of [...this.links.keys()]) this.dropLink(desktopId, 'the server is stopping')
    this.port.close()
  }

  /** Desktops with a session right now. */
  connectedDesktops(): string[] {
    return [...this.links.keys()]
  }

  /** Bytes queued on the relay socket that the OS hasn't taken (tests, diagnostics). */
  socketBuffered(): number {
    return this.port.bufferedAmount()
  }

  /**
   * Dev pairing (protocol/SERVER.md §7): store the desktop with these keys, make a
   * relay offer, and return the code the desktop takes. When the desktop joins the
   * offer, the server authorizes the pair.
   */
  async offerDevPair(desktop: DevKeys & { name?: string }): Promise<string> {
    const id = deviceId(b64uDecode(desktop.ed25519Pub))
    this.desktops.add({ id, name: desktop.name?.trim() || 'desktop', x25519Pub: desktop.x25519Pub, ed25519Pub: desktop.ed25519Pub, pairedAt: Date.now(), lastSeen: null })
    await this.whenOnline()
    const relayToken = deriveRelayToken(randomBytes(32))
    const exp = Math.floor(Date.now() / 1000) + DEV_OFFER_SECONDS
    const offer = { tokenHash: b64uEncode(tokenHash(relayToken)), exp }
    this.devOffers.set(id, offer)
    this.port.send({ t: 'offer', ...offer })
    const identity = this.options.identity.get()
    this.options.log(`link devPair offer desktop=${id} exp=${new Date(exp * 1000).toISOString()}`)
    return encodeDevPairCode({
      id: identity.id,
      x25519Pub: b64uEncode(identity.x25519.pub),
      ed25519Pub: b64uEncode(identity.ed25519.pub),
      name: this.options.name(),
      token: b64uEncode(relayToken),
      exp
    })
  }

  // ---- relay -------------------------------------------------------------------------

  private whenOnline(): Promise<void> {
    if (this.port.getState().kind === 'online') return Promise.resolve()
    return new Promise((resolve) => this.onlineWaiters.push(resolve))
  }

  private onRelayState(state: RelayTransportState): void {
    if (state.kind !== 'online') {
      for (const desktopId of [...this.links.keys()]) this.dropLink(desktopId, 'the relay connection dropped')
      return
    }
    // An offer lives with the socket that made it.
    const now = Date.now() / 1000
    for (const [desktopId, offer] of [...this.devOffers]) {
      if (offer.exp <= now) this.devOffers.delete(desktopId)
      else this.port.send({ t: 'offer', ...offer })
    }
    for (const waiter of this.onlineWaiters.splice(0)) waiter()
  }

  private onPeer(message: PeerMessage): void {
    if (message.state === 'online') {
      const desktop = this.desktops.get(message.id)
      if (desktop && this.devOffers.has(message.id)) {
        this.devOffers.delete(message.id)
        this.port.send({ t: 'authorize', peer: message.id, pub: desktop.ed25519Pub })
        this.options.log(`link devPair authorized desktop=${message.id}`)
      }
      return
    }
    if (message.lastSeen !== undefined) this.desktops.touchLastSeen(message.id, message.lastSeen)
    this.dropLink(message.id, message.state === 'revoked' ? 'the desktop revoked the pairing' : 'the desktop went offline')
  }

  private onRelayError(message: ErrorMessage): void {
    if (message.to && message.code === 'offline') {
      this.dropLink(message.to, 'the desktop went offline')
      return
    }
    this.options.log(`link relayError code=${message.code}${message.to ? ` to=${message.to}` : ''}${message.message ? ` message=${message.message}` : ''}`)
  }

  // ---- channel -----------------------------------------------------------------------

  private onFrame(from: string, data: Uint8Array): void {
    let envelope: Envelope
    try {
      envelope = decodeEnvelope(data)
    } catch {
      this.sendEnvelope(from, FrameKind.Reset)
      return
    }
    switch (envelope.kind) {
      case FrameKind.Handshake1:
        this.handshake(from, envelope.body)
        return
      case FrameKind.Transport: {
        const link = this.links.get(from)
        if (!link) {
          this.sendEnvelope(from, FrameKind.Reset)
          return
        }
        if (!link.receive(envelope.body)) {
          this.dropLink(from, 'undecryptable message')
          this.sendEnvelope(from, FrameKind.Reset)
        }
        return
      }
      case FrameKind.Reset:
        this.dropLink(from, 'reset by the desktop')
        return
      case FrameKind.Handshake2:
        return
    }
  }

  private handshake(from: string, body: Uint8Array): void {
    // A new message 1 always replaces the desktop's session.
    this.dropLink(from, 'a new handshake')
    const identity = this.options.identity.get()
    let outcome: ReturnType<typeof answerHandshake>
    try {
      outcome = answerHandshake(
        identity.x25519,
        body,
        () => ({ ...buildHello('devtool-server', this.options.build, this.options.name()), v: this.version.v, min: this.version.min }),
        ({ remoteStatic }) => {
          const desktop = this.desktops.get(from)
          return desktop && desktop.x25519Pub === b64uEncode(remoteStatic) ? 'ok' : 'unknown-device'
        },
        (line) => this.options.log(`link desktop=${from} ${line}`),
        this.version
      )
    } catch (err) {
      // Dropped without a reply: a desktop holding the wrong server key would loop on one.
      this.options.log(`link desktop=${from} message 1 unreadable: ${errorMessage(err)}`)
      return
    }
    this.port.sendBinary(from, outcome.envelope)
    const hello = outcome.hello
    this.options.log(`link desktop=${from} handshake result=${outcome.result}${hello ? ` name=${JSON.stringify(hello.name)} version=${hello.build.version}` : ''}${outcome.update ? ` update=${outcome.update}` : ''}`)
    if (outcome.result !== 'ok' || !outcome.channel || !hello) return
    this.desktops.touchLastSeen(from, Date.now())
    this.desktops.setBuild(from, hello.build)
    this.links.set(from, new DesktopLink(from, outcome.channel, hello, this.port, this.options, this.streams, this.stats))
  }

  private dropLink(desktopId: string, why: string): void {
    const link = this.links.get(desktopId)
    if (!link) return
    this.links.delete(desktopId)
    link.close(why)
    this.options.log(`link desktop=${desktopId} closed (${why})`)
  }

  private sendEnvelope(to: string, kind: FrameKind): void {
    this.port.sendBinary(to, encodeEnvelope(kind))
  }
}

/**
 * One desktop's session on the server. Its windows become registry clients
 * `link:<desktopId>:<win:N>` on their first call (with the window's focus), its
 * broadcasts arrive once through the group sink as `client: '*'`, and when the
 * link goes every one of them is unregistered so PTYs and chats let go of them.
 *
 * Terminal output is batched per window and tab for {@link PTY_COALESCE_MS}; while
 * the relay socket is congested, the tabs writing to this desktop are held back
 * (their PTYs stop being read) until it drains, so no output is ever dropped.
 */
class DesktopLink {
  private readonly group: string
  private readonly session: LinkSession
  private readonly focus = new Map<string, boolean>()
  private waitingForDrain = false
  private closed = false

  constructor(
    readonly desktopId: string,
    private readonly channel: SealedChannel,
    readonly hello: HostLinkHello,
    private readonly port: HostLinkPort,
    private readonly options: ServerLinkOptions,
    streams: StreamKinds,
    private readonly stats: ServerLinkStats
  ) {
    this.group = `link:${desktopId}`
    const transport = relayLinkTransport(port, desktopId, channel)
    this.session = new LinkSession({
      transport,
      side: 'server',
      peer: desktopId,
      onCall: (call) => this.call(call),
      onDetach: (client) => this.options.registry.unregisterClient(this.clientId(client)),
      streams,
      coalesce: { channel: 'pty-data', windowMs: PTY_COALESCE_MS, maxChars: PTY_MESSAGE_CHARS },
      log: options.log,
      timers: options.timers
    })
    options.registry.registerGroup(this.group, (ch, args) => this.push('*', ch, args))
  }

  /** False when the message didn't decrypt (the session is then useless). */
  receive(body: Uint8Array): boolean {
    let plaintext: Uint8Array | null
    try {
      plaintext = this.channel.open(body)
    } catch {
      return false
    }
    if (plaintext) this.session.receive(plaintext)
    return true
  }

  close(why: string): void {
    if (this.closed) return
    this.closed = true
    this.session.close(new LinkError(LinkErrorCode.ServerOffline, `The link closed: ${why}`))
    this.options.registry.unregisterGroup(this.group)
    this.releaseTerminals()
  }

  private clientId(client: string): string {
    return `${this.group}:${client}`
  }

  private async call({ client, ch, args, focused }: IncomingCall): Promise<unknown> {
    if (!CLIENT_ID.test(client)) throw new LinkError(LinkErrorCode.Protocol, 'Bad client id')
    if (LOCAL_ONLY_CHANNELS.has(ch)) throw new LinkError(LinkErrorCode.Unsupported, `${ch} is for local windows only`)
    if (!this.options.registry.channels().includes(ch)) throw new LinkError(LinkErrorCode.Unsupported, `No handler for ${ch}`)
    const id = this.clientId(client)
    this.focus.set(client, focused)
    if (!this.options.registry.hasClient(id)) {
      this.options.registry.registerClient(id, (channel, pushArgs) => this.push(client, channel, pushArgs), {
        isFocused: () => this.focus.get(client) ?? false,
        group: this.group
      })
    }
    try {
      return await this.options.registry.call(id, ch, args)
    } catch (err) {
      throw new LinkError(LinkErrorCode.Remote, errorMessage(err))
    }
  }

  private push(client: string, ch: string, args: unknown[]): void {
    if (this.closed) return
    this.session.sendEvent(client, ch, args)
    if (ch === 'pty-data' && typeof args[0] === 'string') this.holdIfCongested(args[0])
  }

  private holdIfCongested(tabId: string): void {
    if (!this.session.congested()) return
    const holder = this.group
    if (this.options.terminals.holdTerminalOutput(tabId, holder)) this.stats.holds++
    if (this.waitingForDrain) return
    this.waitingForDrain = true
    this.session.whenDrained(() => {
      this.waitingForDrain = false
      this.releaseTerminals()
    })
  }

  private releaseTerminals(): void {
    const holder = this.group
    for (const tabId of this.options.terminals.terminalOutputHeldBy(holder)) {
      this.options.terminals.releaseTerminalOutput(tabId, holder)
      this.stats.releases++
    }
  }
}

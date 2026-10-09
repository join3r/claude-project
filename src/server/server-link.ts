import {
  FrameKind,
  b64uEncode,
  decodeEnvelope,
  derivePairProof,
  deriveRelayToken,
  encodeEnvelope
} from '../../protocol/ts/index.ts'
import type { Envelope, ErrorMessage, PeerMessage, VersionInfo } from '../../protocol/ts/index.ts'
import type { DesktopIdentity } from '../main/mobile/identity'
import type { RelayTransportState } from '../main/mobile/mobile-service'
import { diagnosticStreamKinds } from '../main/host/link/diagnostic-streams'
import { LinkError, LinkErrorCode, errorMessage } from '../main/host/link/errors'
import { buildHello, type HostLinkHello, type LinkBuild } from '../main/host/link/handshake'
import {
  PAIRING_REJECTION_TEXT,
  PAIRING_VERSION,
  PairFrame,
  PairingError,
  PairingInitiator,
  PairingOffer,
  answerPairing,
  encodeTicket,
  helloProof,
  isTicketExpired,
  type PairingTicket
} from '../main/host/link/pairing'
import { PeerStore, type PeerRecord } from '../main/host/link/peer-store'
import type { HostLinkPort, RelayMux } from '../main/host/link/relay-mux'
import { relayLinkTransport } from '../main/host/link/relay-transport'
import { answerHandshake, isLinkHandshake, type SealedChannel } from '../main/host/link/secure'
import { LinkSession, type IncomingCall, type LinkTimers } from '../main/host/link/session'
import type { StreamKinds } from '../main/host/link/stream'
import { HOST_LINK_MIN_VERSION, HOST_LINK_PROTOCOL_VERSION } from '../main/host/link/version'
import type { ServerHostInfo } from '../shared/servers'
import type { ClientRegistry } from './client-registry'

/** Terminal output batching on the server (plan: at most one message per tab and client per 16 ms). */
export const PTY_COALESCE_MS = 16
/** Characters of terminal output in one message: at most 48 KiB of UTF-8, so one Noise message. */
export const PTY_MESSAGE_CHARS = 16 * 1024
/** Channels a linked desktop may not call: `scrollback-save-sync` blocks a local window only. */
const LOCAL_ONLY_CHANNELS = new Set(['scrollback-save-sync'])
/** A desktop's own client ids (`win:3`). */
const CLIENT_ID = /^[A-Za-z0-9._-]{1,24}(:[A-Za-z0-9._-]{1,24})?$/
/** How long the token flow waits for the relay, then for the desktop's answer. */
const RELAY_WAIT_MS = 20_000
const PAIRING_ANSWER_MS = 30_000

/** The host's terminal flow control (HostServices). */
export interface TerminalFlow {
  holdTerminalOutput(tabId: string, holder: string): boolean
  releaseTerminalOutput(tabId: string, holder: string): void
  terminalOutputHeldBy(holder: string): string[]
}

/** A link-level call (`server-*`, protocol/SERVER.md §5.1) from a paired desktop. */
export interface LinkCall {
  desktopId: string
  ch: string
  args: unknown[]
}

export interface ServerLinkOptions {
  relay: RelayMux
  identity: { get(): DesktopIdentity }
  /** The host's channels. The bootstrap has none: then only link-level calls are served. */
  registry?: ClientRegistry
  terminals?: TerminalFlow
  /** The server's data dir: the paired desktops live in `desktops.json`. */
  dataDir: string
  relayUrl: () => string
  name: () => string
  /** What the handshake says about this build (the installed bundle's manifest). */
  build: () => LinkBuild
  host: () => ServerHostInfo
  /** `bootstrap` while installing. */
  features?: string[]
  log: (message: string) => void
  /** Stream kinds desktops may open; by default the diagnostic ones (`echo`, `sink`, `source`). */
  streams?: StreamKinds
  /**
   * Link-level calls, answered before the registry: return undefined for a channel
   * this side doesn't serve as one.
   */
  linkCall?: (call: LinkCall) => Promise<unknown> | undefined
  /** A desktop paired with this server (either flow). */
  onPaired?: (desktop: PeerRecord) => void
  /** A desktop's session came up or went away. */
  onSessionsChanged?: () => void
  /** Tests: speak another protocol version range. */
  version?: VersionInfo
  timers?: LinkTimers
  now?: () => number
}

/** Counters for tests and the live check. */
export interface ServerLinkStats {
  /** Times a congested link held a terminal's output back. */
  holds: number
  /** Times it let them go again. */
  releases: number
}

/** The code `devtool-server pair` shows, and what became of it. */
export interface PairingCodeState {
  code: string
  /** Unix seconds. */
  exp: number
  state: 'waiting' | 'paired' | 'expired' | 'cancelled'
  desktop?: { id: string; name: string }
}

interface PendingTokenPairing {
  desktopId: string
  initiator: PairingInitiator
  resolve: (record: PeerRecord) => void
  reject: (error: PairingError) => void
  ticket: PairingTicket
}

/**
 * The server's end of the host link: the Noise responder for every paired desktop
 * on the relay socket the phones would use too, one {@link DesktopLink} per
 * connected desktop, and both pairing flows (protocol/SERVER.md §7): it answers a
 * desktop's pairing hello for a code it minted, and the bootstrap pairs through it
 * with an install token.
 */
export class ServerLink {
  readonly desktops: PeerStore
  readonly stats: ServerLinkStats = { holds: 0, releases: 0 }
  private readonly port: HostLinkPort
  private readonly links = new Map<string, DesktopLink>()
  private readonly onlineWaiters: (() => void)[] = []
  private readonly streams: StreamKinds
  private readonly version: VersionInfo
  private readonly now: () => number
  /** The live pairing code (code flow): one at a time. */
  private code: { offer: PairingOffer; text: string; state: PairingCodeState['state']; desktop?: { id: string; name: string } } | null = null
  private codeTimer: ReturnType<typeof setTimeout> | null = null
  private tokenPairing: PendingTokenPairing | null = null
  private started = false

  constructor(private readonly options: ServerLinkOptions) {
    this.desktops = new PeerStore(options.dataDir, 'desktops.json', options.log)
    this.streams = options.streams ?? diagnosticStreamKinds()
    this.version = options.version ?? { v: HOST_LINK_PROTOCOL_VERSION, min: HOST_LINK_MIN_VERSION }
    this.now = options.now ?? Date.now
    // The link owns its paired desktops and the one it is pairing with by token.
    // Every other peer is the phones' (the mobile service on the same socket),
    // except a desktop's pairing hello for this server's code and a link
    // handshake from a desktop this server has forgotten, which then hears
    // `unknown-device` (protocol/SERVER.md §3).
    this.port = options.relay.hostPort((peerId) => this.desktops.has(peerId) || this.tokenPairing?.desktopId === peerId, {
      frame: (from, envelope) => this.onFrame(from, envelope),
      peer: (message) => this.onPeer(message),
      error: (message) => this.onRelayError(message),
      pairing: (from, envelope) => this.onFrame(from, envelope),
      claimHandshake: (_from, envelope) => isLinkHandshake(this.options.identity.get().x25519, envelope.subarray(1))
    })
    this.port.onStateChange((state) => this.onRelayState(state))
    this.port.onOfferTaken(() => {
      if (this.code?.state !== 'waiting') return
      this.options.log('link pairing code replaced by another offer')
      this.endCode('cancelled')
    })
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
    this.failTokenPairing(new PairingError('cancelled', 'The server stopped'))
    this.port.close()
    if (this.codeTimer) clearTimeout(this.codeTimer)
    this.codeTimer = null
  }

  /** The relay socket's state (`devtool-server status`). */
  relayState(): RelayTransportState {
    return this.port.getState()
  }

  /** Desktops with a session right now. */
  connectedDesktops(): string[] {
    return [...this.links.keys()]
  }

  /** Bytes queued on the relay socket that the OS hasn't taken (tests, diagnostics). */
  socketBuffered(): number {
    return this.port.bufferedAmount()
  }

  /** A link-level event (`server-status`) for every connected desktop's windows. */
  broadcast(ch: string, args: unknown[]): void {
    for (const link of this.links.values()) link.sendEvent('*', ch, args)
  }

  /**
   * Revokes a desktop's pairing: the relay pair, its record and its session. It
   * hears `peer revoked` if it is connected.
   */
  unpair(desktopId: string): boolean {
    const known = this.desktops.remove(desktopId)
    this.port.send({ t: 'revoke', peer: desktopId })
    this.dropLink(desktopId, 'unpaired')
    if (known) this.options.log(`link desktop=${desktopId} unpaired`)
    return known
  }

  // ---- code flow (this server minted the secret) -------------------------------------

  /**
   * A fresh pairing code for another desktop (`devtool-server pair`, "Add another
   * device"): a 15 minute single-use relay offer. It replaces any earlier code.
   */
  async createPairingCode(waitMs = RELAY_WAIT_MS): Promise<PairingCodeState> {
    await this.whenOnline(waitMs)
    const identity = this.options.identity.get()
    const offer = PairingOffer.mint(this.now())
    const text = encodeTicket({
      kind: 'device',
      relay: this.options.relayUrl(),
      id: identity.id,
      x25519Pub: identity.x25519.pub,
      ed25519Pub: identity.ed25519.pub,
      secret: offer.secret,
      exp: offer.exp,
      name: this.options.name()
    })
    if (this.codeTimer) clearTimeout(this.codeTimer)
    this.code = { offer, text, state: 'waiting' }
    this.codeTimer = setTimeout(() => {
      this.codeTimer = null
      if (this.code?.offer === offer && this.code.state === 'waiting') this.endCode('expired')
    }, Math.max(0, offer.exp * 1000 - this.now()))
    this.codeTimer.unref?.()
    this.port.send(offer.offerMessage())
    this.options.log(`link pairing code offered exp=${new Date(offer.exp * 1000).toISOString()}`)
    return this.codeState()!
  }

  cancelPairingCode(): void {
    if (this.code?.state === 'waiting') this.endCode('cancelled')
  }

  codeState(): PairingCodeState | null {
    const code = this.code
    if (!code) return null
    const state = code.state === 'waiting' && code.offer.expired(this.now()) ? 'expired' : code.state
    return { code: code.text, exp: code.offer.exp, state, ...(code.desktop ? { desktop: { ...code.desktop } } : {}) }
  }

  private endCode(state: 'expired' | 'cancelled'): void {
    if (!this.code) return
    this.code.state = state
    if (this.codeTimer) clearTimeout(this.codeTimer)
    this.codeTimer = null
  }

  // ---- token flow (the bootstrap holds a desktop's install token) ----------------------

  /**
   * Pairs with the desktop that minted `ticket`: joins its relay offer, proves the
   * secret in a pairing handshake and stores the desktop, which then authorizes the
   * pair and starts the link's handshake. Rejects with a {@link PairingError}.
   */
  async pairWithInstallToken(ticket: PairingTicket, extra: { bootstrap?: number } = {}): Promise<PeerRecord> {
    if (ticket.kind !== 'install') throw new PairingError('wrong-secret', 'Not an install token')
    if (isTicketExpired(ticket, this.now())) throw new PairingError('expired', 'This install command has expired')
    this.failTokenPairing(new PairingError('cancelled', 'Another pairing started'))
    await this.whenOnline(RELAY_WAIT_MS)
    const identity = this.options.identity.get()
    const initiator = new PairingInitiator(identity.x25519, ticket.x25519Pub)
    const message1 = initiator.start({
      ...PAIRING_VERSION,
      app: 'devtool-server',
      proof: b64uEncode(derivePairProof(ticket.secret)),
      ed: b64uEncode(identity.ed25519.pub),
      name: this.options.name(),
      build: this.options.build(),
      host: this.options.host(),
      ...(extra.bootstrap ? { bootstrap: extra.bootstrap } : {})
    })
    return new Promise<PeerRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failTokenPairing(new PairingError('timeout', 'DevTool did not answer. Is it open, and is the invite still on screen?'))
      }, PAIRING_ANSWER_MS)
      this.tokenPairing = {
        desktopId: ticket.id,
        initiator,
        ticket,
        resolve: (record) => { clearTimeout(timer); resolve(record) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      }
      this.port.send({ t: 'pair', to: ticket.id, token: b64uEncode(deriveRelayToken(ticket.secret)) })
      this.port.sendBinary(ticket.id, message1)
    })
  }

  private failTokenPairing(error: PairingError): void {
    const pending = this.tokenPairing
    this.tokenPairing = null
    pending?.reject(error)
  }

  private finishTokenPairing(from: string, body: Uint8Array): void {
    const pending = this.tokenPairing
    if (!pending || pending.desktopId !== from) return
    this.tokenPairing = null
    let reply
    try {
      reply = pending.initiator.finish(body)
    } catch (err) {
      pending.reject(new PairingError('incompatible', `DevTool's pairing answer was unreadable: ${errorMessage(err)}`))
      return
    }
    if (reply.result === 'incompatible') {
      pending.reject(new PairingError('incompatible', 'This DevTool cannot pair with this installer. Update DevTool and create a new install command.'))
      return
    }
    if (reply.result !== 'ok') {
      const reason = reply.reason ?? 'wrong-secret'
      pending.reject(new PairingError(reason, `DevTool refused the pairing: ${PAIRING_REJECTION_TEXT[reason]}`))
      return
    }
    const now = this.now()
    const record: PeerRecord = {
      id: pending.ticket.id,
      name: reply.name || pending.ticket.name || 'desktop',
      x25519Pub: b64uEncode(pending.ticket.x25519Pub),
      ed25519Pub: b64uEncode(pending.ticket.ed25519Pub),
      pairedAt: now,
      lastSeen: now,
      build: reply.build
    }
    this.desktops.add(record)
    this.options.log(`link paired desktop=${record.id} name=${JSON.stringify(record.name)} (install token)`)
    this.options.onPaired?.(record)
    pending.resolve(record)
  }

  // ---- relay -------------------------------------------------------------------------

  private whenOnline(timeoutMs: number): Promise<void> {
    if (this.port.getState().kind === 'online') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.onlineWaiters.indexOf(done)
        if (index !== -1) this.onlineWaiters.splice(index, 1)
        const state = this.port.getState()
        const why = state.kind === 'offline' && state.error ? `: ${state.error}` : ''
        reject(new PairingError('relay-unreachable', `Cannot reach the relay at ${this.options.relayUrl()}${why}`))
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      this.onlineWaiters.push(done)
    })
  }

  private onRelayState(state: RelayTransportState): void {
    if (state.kind !== 'online') {
      for (const desktopId of [...this.links.keys()]) this.dropLink(desktopId, 'the relay connection dropped')
      return
    }
    // An offer lives with the socket that made it.
    const code = this.code
    if (code && code.state === 'waiting' && !code.offer.consumed && !code.offer.expired(this.now())) {
      this.port.send(code.offer.offerMessage())
    }
    for (const waiter of this.onlineWaiters.splice(0)) waiter()
  }

  private onPeer(message: PeerMessage): void {
    if (message.state === 'online') return
    if (this.tokenPairing?.desktopId === message.id) {
      this.failTokenPairing(new PairingError('peer-offline', 'DevTool left the relay before it answered. Keep the Add server dialog open and run the command again.'))
    }
    if (message.lastSeen !== undefined) this.desktops.touchLastSeen(message.id, message.lastSeen)
    if (message.state === 'revoked') {
      // The desktop removed this server: forget it too.
      if (this.desktops.remove(message.id)) this.options.log(`link desktop=${message.id} revoked the pairing`)
    }
    this.dropLink(message.id, message.state === 'revoked' ? 'the desktop revoked the pairing' : 'the desktop went offline')
  }

  private onRelayError(message: ErrorMessage): void {
    const pending = this.tokenPairing
    if (pending && message.to === pending.desktopId && (message.code === 'forbidden' || message.code === 'offline')) {
      this.failTokenPairing(message.code === 'forbidden'
        ? new PairingError('relay-refused', 'The relay refused this install token: it was already used, it expired, or DevTool cancelled the invite')
        : new PairingError('peer-offline', 'DevTool is not connected to the relay. Open DevTool and keep the Add server dialog open.'))
      return
    }
    if (message.to && message.code === 'offline') {
      this.dropLink(message.to, 'the desktop went offline')
      return
    }
    this.options.log(`link relayError code=${message.code}${message.to ? ` to=${message.to}` : ''}${message.message ? ` message=${message.message}` : ''}`)
  }

  // ---- channel -----------------------------------------------------------------------

  private onFrame(from: string, data: Uint8Array): void {
    if (data.length > 0 && data[0] === PairFrame.Hello) {
      this.answerPairingHello(from, data.subarray(1))
      return
    }
    if (data.length > 0 && data[0] === PairFrame.Reply) {
      this.finishTokenPairing(from, data.subarray(1))
      return
    }
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

  /** Code flow: a desktop proves the secret of the code this server showed. */
  private answerPairingHello(from: string, body: Uint8Array): void {
    const identity = this.options.identity.get()
    const code = this.code
    let outcome: ReturnType<typeof answerPairing>
    try {
      outcome = answerPairing(
        identity.x25519,
        body,
        from,
        'devtool-desktop',
        () => ({ app: 'devtool-server', name: this.options.name(), build: this.options.build(), host: this.options.host() }),
        ({ hello, remoteStatic }) => {
          if (!code || code.state === 'cancelled') return { result: 'rejected', reason: 'no-offer' }
          const proof = helloProof(hello)
          if (!proof) return { result: 'rejected', reason: 'wrong-secret' }
          const check = code.offer.check(proof, { id: from, x25519Pub: b64uEncode(remoteStatic) }, this.now())
          return check.ok ? { result: 'ok' } : { result: 'rejected', reason: check.reason }
        }
      )
    } catch (err) {
      this.options.log(`link desktop=${from} pairing hello unreadable: ${errorMessage(err)}`)
      return
    }
    this.port.sendBinary(from, outcome.envelope)
    const hello = outcome.hello
    this.options.log(`link desktop=${from} pairing result=${outcome.result}${outcome.reason ? ` reason=${outcome.reason}` : ''}${hello ? ` name=${JSON.stringify(hello.name)}` : ''}`)
    if (outcome.result !== 'ok' || !hello || !code) return
    const now = this.now()
    const record: PeerRecord = {
      id: from,
      name: hello.name || 'desktop',
      x25519Pub: b64uEncode(outcome.remoteStatic),
      ed25519Pub: hello.ed,
      pairedAt: this.desktops.get(from)?.pairedAt ?? now,
      lastSeen: now,
      build: hello.build
    }
    this.desktops.add(record)
    this.port.send({ t: 'authorize', peer: from, pub: hello.ed })
    const first = code.state === 'waiting'
    code.state = 'paired'
    code.desktop = { id: from, name: record.name }
    if (this.codeTimer) clearTimeout(this.codeTimer)
    this.codeTimer = null
    if (first) this.options.onPaired?.(record)
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
        () => ({ ...buildHello('devtool-server', this.options.build(), this.options.name(), this.options.features ?? [], this.options.host()), v: this.version.v, min: this.version.min }),
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
    this.desktops.touchLastSeen(from, this.now())
    this.desktops.setBuild(from, hello.build)
    this.links.set(from, new DesktopLink(from, outcome.channel, hello, this.port, this.options, this.streams, this.stats))
    this.options.onSessionsChanged?.()
  }

  private dropLink(desktopId: string, why: string): void {
    const link = this.links.get(desktopId)
    if (!link) return
    this.links.delete(desktopId)
    link.close(why)
    this.options.log(`link desktop=${desktopId} closed (${why})`)
    this.options.onSessionsChanged?.()
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
      onDetach: (client) => this.options.registry?.unregisterClient(this.clientId(client)),
      streams,
      coalesce: { channel: 'pty-data', windowMs: PTY_COALESCE_MS, maxChars: PTY_MESSAGE_CHARS },
      log: options.log,
      timers: options.timers
    })
    options.registry?.registerGroup(this.group, (ch, args) => this.push('*', ch, args))
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

  sendEvent(client: string, ch: string, args: unknown[]): void {
    if (!this.closed) this.session.sendEvent(client, ch, args)
  }

  close(why: string): void {
    if (this.closed) return
    this.closed = true
    this.session.close(new LinkError(LinkErrorCode.ServerOffline, `The link closed: ${why}`))
    this.options.registry?.unregisterGroup(this.group)
    this.releaseTerminals()
  }

  private clientId(client: string): string {
    return `${this.group}:${client}`
  }

  private async call({ client, ch, args, focused }: IncomingCall): Promise<unknown> {
    if (!CLIENT_ID.test(client)) throw new LinkError(LinkErrorCode.Protocol, 'Bad client id')
    if (LOCAL_ONLY_CHANNELS.has(ch)) throw new LinkError(LinkErrorCode.Unsupported, `${ch} is for local windows only`)
    const linkLevel = this.options.linkCall?.({ desktopId: this.desktopId, ch, args })
    if (linkLevel !== undefined) {
      try {
        return await linkLevel
      } catch (err) {
        throw err instanceof LinkError ? err : new LinkError(LinkErrorCode.Remote, errorMessage(err))
      }
    }
    const registry = this.options.registry
    if (!registry || !registry.channels().includes(ch)) throw new LinkError(LinkErrorCode.Unsupported, `No handler for ${ch}`)
    const id = this.clientId(client)
    this.focus.set(client, focused)
    if (!registry.hasClient(id)) {
      registry.registerClient(id, (channel, pushArgs) => this.push(client, channel, pushArgs), {
        isFocused: () => this.focus.get(client) ?? false,
        group: this.group
      })
    }
    try {
      return await registry.call(id, ch, args)
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
    const terminals = this.options.terminals
    if (!terminals || !this.session.congested()) return
    const holder = this.group
    if (terminals.holdTerminalOutput(tabId, holder)) this.stats.holds++
    if (this.waitingForDrain) return
    this.waitingForDrain = true
    this.session.whenDrained(() => {
      this.waitingForDrain = false
      this.releaseTerminals()
    })
  }

  private releaseTerminals(): void {
    const terminals = this.options.terminals
    if (!terminals) return
    const holder = this.group
    for (const tabId of terminals.terminalOutputHeldBy(holder)) {
      terminals.releaseTerminalOutput(tabId, holder)
      this.stats.releases++
    }
  }
}

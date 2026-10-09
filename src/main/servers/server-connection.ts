import { FrameKind, ProtocolError, decodeEnvelope, encodeEnvelope, negotiateVersion } from '../../../protocol/ts/index.ts'
import type { Envelope, KeyPair, VersionInfo } from '../../../protocol/ts/index.ts'
import { LinkError, LinkErrorCode, errorMessage } from '../host/link/errors'
import type { HostLinkHello, HostLinkReply } from '../host/link/handshake'
import { LinkInitiator, type SealedChannel } from '../host/link/secure'
import { LinkSession, type IncomingEvent, type LinkTimers } from '../host/link/session'
import type { LinkStream } from '../host/link/stream'
import type { HostLinkPort } from '../host/link/relay-mux'
import { relayLinkTransport } from '../host/link/relay-transport'
import type { ServerConnectionKind, ServerStatus } from '../../shared/servers'

/** Message 2 has this long to arrive before the attempt counts as failed. */
export const HANDSHAKE_TIMEOUT_MS = 10_000
/** Reconnect backoff (plan: 1 s → 30 s), reset by a session that comes up. */
export const MIN_RETRY_MS = 1000
export const MAX_RETRY_MS = 30_000

export interface ConnectionTimers extends LinkTimers {
  now(): number
}

export interface ServerConnectionDeps {
  /** The server's device ID. */
  id: string
  /** Its Noise static key, from the pairing record. */
  serverStatic: () => Uint8Array
  /** This desktop's Noise static key (the identity loads on first use). */
  staticKey: () => KeyPair
  hello: () => HostLinkHello
  /** This build's version range, to tell which side is too old. */
  version: VersionInfo
  port: HostLinkPort
  timers: ConnectionTimers
  log: (message: string) => void
  /** The connection's state changed. */
  onChange: () => void
  /** A handshake answered `ok`. */
  onEstablished: (reply: HostLinkReply) => void
  onEvent: (event: IncomingEvent) => void
}

type Problem = NonNullable<ServerStatus['problem']>

/**
 * The desktop's link to one server: the Noise initiator, the session once it is
 * up, and reconnects. It handshakes whenever the relay says the server is online
 * (and the relay itself is), retries a failed attempt with backoff, and fails
 * every pending call with `server-offline` when the session goes.
 */
export class ServerConnection {
  private kind: ServerConnectionKind = 'offline'
  private error: string | undefined
  private problem: Problem | undefined
  private update: 'desktop' | 'server' | undefined
  /** The relay reports the server online (or a dev pairing let us assume so). */
  private present = false
  private initiator: LinkInitiator | null = null
  private channel: SealedChannel | null = null
  private session: LinkSession | null = null
  private handshakeTimer: unknown = null
  private retryTimer: unknown = null
  private backoff = MIN_RETRY_MS
  private stopped = false

  constructor(private readonly deps: ServerConnectionDeps) {}

  get id(): string {
    return this.deps.id
  }

  get state(): ServerConnectionKind {
    return this.kind
  }

  status(): Pick<ServerStatus, 'state' | 'error' | 'problem' | 'update'> {
    return {
      state: this.kind,
      ...(this.error ? { error: this.error } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
      ...(this.update ? { update: this.update } : {})
    }
  }

  // ---- presence --------------------------------------------------------------------

  /** The relay says the server is online (or it came back): handshake unless a session is up or starting. */
  serverOnline(): void {
    if (this.stopped) return
    this.present = true
    if (this.session || this.initiator) return
    this.cancelRetry()
    this.backoff = MIN_RETRY_MS
    this.connect()
  }

  /** The server went offline, or the relay socket did. */
  serverOffline(reason?: { error?: string; problem?: Problem }): void {
    this.present = false
    this.cancelRetry()
    this.endSession(new LinkError(LinkErrorCode.ServerOffline, 'The server went offline'))
    this.set('offline', reason?.error, reason?.problem)
  }

  stop(): void {
    this.stopped = true
    this.serverOffline()
  }

  // ---- traffic -----------------------------------------------------------------------

  call(clientId: string, ch: string, args: unknown[], focused = false): Promise<unknown> {
    if (!this.session) return Promise.reject(this.offlineError())
    return this.session.call(clientId, ch, args, focused)
  }

  openStream(kind: string, params: unknown): LinkStream {
    if (!this.session) throw this.offlineError()
    return this.session.openStream(kind, params)
  }

  detach(clientId: string): void {
    this.session?.detach(clientId)
  }

  /** An envelope from the server. */
  receive(data: Uint8Array): void {
    if (this.stopped) return
    let envelope: Envelope
    try {
      envelope = decodeEnvelope(data)
    } catch {
      this.sendEnvelope(FrameKind.Reset)
      return
    }
    switch (envelope.kind) {
      case FrameKind.Handshake2:
        this.finishHandshake(envelope.body)
        return
      case FrameKind.Transport:
        this.transportMessage(envelope.body)
        return
      case FrameKind.Reset:
        // The server has no session for us (it restarted, or dropped ours): start over.
        if (this.session) {
          this.deps.log(`server=${this.deps.id} reset by the server`)
          this.endSession(new LinkError(LinkErrorCode.ServerOffline, 'The server reset the link'))
          this.set('connecting')
          this.scheduleRetry()
        }
        return
      case FrameKind.Handshake1:
        // Only desktops start handshakes toward servers.
        return
    }
  }

  // ---- handshake ---------------------------------------------------------------------

  private connect(): void {
    if (this.stopped || !this.present) return
    this.endSession(new LinkError(LinkErrorCode.ServerOffline, 'Reconnecting to the server'))
    let message1: Uint8Array
    try {
      this.initiator = new LinkInitiator(this.deps.staticKey(), this.deps.serverStatic(), (line) => this.deps.log(`server=${this.deps.id} ${line}`))
      message1 = this.initiator.start(this.deps.hello())
    } catch (err) {
      this.initiator = null
      this.deps.log(`server=${this.deps.id} handshake not started: ${errorMessage(err)}`)
      this.set('offline', errorMessage(err))
      return
    }
    this.set('connecting')
    this.deps.port.sendBinary(this.deps.id, message1)
    this.handshakeTimer = this.deps.timers.setTimeout(() => {
      this.handshakeTimer = null
      if (!this.initiator) return
      this.initiator = null
      this.deps.log(`server=${this.deps.id} handshake timed out`)
      this.scheduleRetry()
    }, HANDSHAKE_TIMEOUT_MS)
  }

  private finishHandshake(body: Uint8Array): void {
    const initiator = this.initiator
    if (!initiator) return
    this.initiator = null
    this.clearHandshakeTimer()
    let outcome: ReturnType<LinkInitiator['finish']>
    try {
      outcome = initiator.finish(body)
    } catch (err) {
      this.deps.log(`server=${this.deps.id} message 2 unreadable: ${errorMessage(err)}`)
      this.scheduleRetry()
      return
    }
    const { reply, channel } = outcome
    if (reply.result === 'incompatible') {
      const negotiation = negotiateVersion(this.deps.version, reply.v > 0 ? reply : { v: 1, min: 1 })
      const update = !negotiation.ok && negotiation.update === 'local' ? 'desktop' : 'server'
      this.deps.log(`server=${this.deps.id} handshake result=incompatible server v=${reply.v} min=${reply.min} update=${update}`)
      this.set('incompatible', update === 'desktop' ? 'Update DevTool to use this server' : 'This server needs an update', undefined, update)
      return
    }
    if (reply.result === 'unknown-device' || !channel) {
      this.deps.log(`server=${this.deps.id} handshake result=${reply.result}`)
      this.set('offline', 'This server does not know this desktop. Pair it again.', 'unknown-device')
      return
    }
    this.channel = channel
    this.session = new LinkSession({
      transport: relayLinkTransport(this.deps.port, this.deps.id, channel),
      side: 'desktop',
      peer: this.deps.id,
      onEvent: (event) => this.deps.onEvent(event),
      log: this.deps.log,
      timers: this.deps.timers
    })
    this.backoff = MIN_RETRY_MS
    this.deps.log(`server=${this.deps.id} online version=${reply.build.version} commit=${reply.build.commit.slice(0, 12)}`)
    this.set('online')
    this.deps.onEstablished(reply)
  }

  private transportMessage(body: Uint8Array): void {
    const channel = this.channel
    const session = this.session
    if (!channel || !session) {
      this.sendEnvelope(FrameKind.Reset)
      return
    }
    let plaintext: Uint8Array | null
    try {
      plaintext = channel.open(body)
    } catch {
      // Counters out of step: only a new handshake fixes that.
      this.deps.log(`server=${this.deps.id} undecryptable message; reconnecting`)
      this.endSession(new LinkError(LinkErrorCode.ServerOffline, 'The link to the server broke'))
      this.sendEnvelope(FrameKind.Reset)
      this.set('connecting')
      this.scheduleRetry()
      return
    }
    if (!plaintext) return
    try {
      session.receive(plaintext)
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      this.deps.log(`server=${this.deps.id} bad message: ${err.message}`)
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    if (!this.present) {
      this.set('offline')
      return
    }
    this.cancelRetry()
    const delay = this.backoff
    this.backoff = Math.min(MAX_RETRY_MS, this.backoff * 2)
    if (this.kind !== 'connecting') this.set('connecting')
    this.retryTimer = this.deps.timers.setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private endSession(error: LinkError): void {
    this.clearHandshakeTimer()
    this.initiator = null
    this.channel = null
    const session = this.session
    this.session = null
    session?.close(error)
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      this.deps.timers.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      this.deps.timers.clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  private offlineError(): LinkError {
    return new LinkError(LinkErrorCode.ServerOffline, this.kind === 'incompatible' ? (this.error ?? 'The server is incompatible') : 'The server is offline')
  }

  private sendEnvelope(kind: FrameKind): void {
    this.deps.port.sendBinary(this.deps.id, encodeEnvelope(kind))
  }

  private set(kind: ServerConnectionKind, error?: string, problem?: Problem, update?: 'desktop' | 'server'): void {
    const same = this.kind === kind && this.error === error && this.problem === problem && this.update === update
    this.kind = kind
    this.error = error
    this.problem = problem
    this.update = update
    if (!same) this.deps.onChange()
  }
}

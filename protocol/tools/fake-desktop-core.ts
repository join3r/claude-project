import { randomBytes } from 'node:crypto'
import {
  AppErrorCode,
  AppOp,
  DEVTOOL_NOISE_PROLOGUE,
  FrameKind,
  FramedTransport,
  MIN_PROTOCOL_VERSION,
  PAIRING_TTL_SECONDS,
  PROTOCOL_VERSION,
  TASK_CLOSE_FEATURE,
  TASK_LAND_FEATURE,
  ChatOp,
  ProtocolError,
  b64uDecode,
  b64uEncode,
  buildHello,
  bytesEqual,
  constantTimeEqual,
  createResponder,
  decodeEnvelope,
  derivePairProof,
  deriveRelayToken,
  deviceId,
  encodeEnvelope,
  encodeJson,
  encodePairingUri,
  negotiateVersion,
  parseAppMessage,
  parseChatParams,
  parseHelloVersion,
  parsePhoneHello,
  parseTaskCloseParams,
  parseTaskLandParams,
  tokenHash,
  toBytes,
  utf8Encode
} from '../ts/index.ts'
import { FakeChat } from './fake-chat.ts'
import type { ChatPatch } from './fake-chat.ts'
import type {
  AppMessage,
  ChatAnswerParams,
  ChatDetailParams,
  ChatEarlierParams,
  ChatSendParams,
  ClientMessage,
  DesktopHello,
  HandshakeResult,
  Inbox,
  InboxTabStatus,
  KeyPair,
  PhoneHello,
  ServerMessage,
  TaskCloseResult,
  TaskLandResult,
  TaskLanding
} from '../ts/index.ts'

/**
 * The I/O-free half of `fake-desktop.ts`: everything a desktop does between the relay
 * socket and the phone, driven by `handleServerMessage` and `tick`. Kept separate so
 * tests can run a real phone handshake against it without a relay or a socket.
 */

export interface DesktopIdentity {
  x25519: KeyPair
  ed25519: KeyPair
}

/** Same shape as the real desktop's `<configDir>/mobile/pairings.json` (plan, piece C). */
export interface StoredPairing {
  id: string
  name: string
  /** b64u */
  x25519Pub: string
  /** b64u */
  ed25519Pub: string
  pairedAt: number
  lastSeen: number | null
}

export interface PairingRequest {
  phoneId: string
  deviceName: string
  app: string
}

export interface FakeDesktopOptions {
  identity: DesktopIdentity
  name: string
  /** Relay base URL as it goes into the QR code. */
  relayUrl: string
  pairings: StoredPairing[]
  savePairings(pairings: StoredPairing[]): void
  sendRelay(message: ClientMessage): void
  /** Resolves true to accept a pairing request. */
  approve(request: PairingRequest): Promise<boolean>
  /** Called with each new pairing URI (on connect, and again whenever the offer expires). */
  onOffer(uri: string, exp: number): void
  log(line: string): void
  now?(): number
  randomSecret?(): Uint8Array
  /** Timers for the canned chat; defaults to setTimeout. Returns a cancel function. */
  schedule?(fn: () => void, ms: number): () => void
}

interface LiveOffer {
  pairProof: Uint8Array
  exp: number
  uri: string
}

interface Session {
  transport: FramedTransport
  /** `pending` until the user accepts a new pairing; pending phones get no data. */
  state: 'accepted' | 'pending'
  seq: number
  hello: PhoneHello
  /** The chat tab this phone has open (one per phone, §6.3), and its evt chat counter. */
  openChat: string | null
  chatSeq: number
}

const APP_VERSION = 'fake-desktop/0.1.0'
/** The canned inbox's claude-chat tab: the one tab `chat.open` accepts. */
export const CHAT_TAB_ID = 'tab-chat'
/** The canned task with a worktree of its own (§4.4 `branch`), the one `task.close` lands and `task.land` acts on. */
export const LAND_TASK_ID = 'task-login'
/** How long the canned agent takes to fix the conflict after `fix-with-agent`. */
const FIX_MS = 3000

/** Where the canned worktree task is: open (maybe stopped landing), or landed and closed. */
export interface CannedLanding {
  closed: boolean
  landing: TaskLanding | null
}

const ROTATION: InboxTabStatus[] = ['working', 'attention', 'idle', 'working', 'exited']
const ACTIVITIES = ['Running Bash', 'Reading files', 'Editing src/auth.ts', 'Thinking', 'Running tests']

/**
 * A small fixed inbox whose first tab walks through every status, so a phone watching
 * it sees a visible change on each `tick`.
 */
export function cannedInbox(desktop: { id: string; name: string }, tick: number, now: number, land: CannedLanding = { closed: false, landing: null }): Inbox {
  const status = ROTATION[tick % ROTATION.length]
  const tickStart = now - (now % 5000)
  return {
    desktop,
    generatedAt: now,
    projects: [
      {
        id: 'proj-api',
        name: 'api-server',
        emoji: '🚀',
        remote: false,
        streams: [
          { id: 'stream-api-main', name: 'main', main: true },
          { id: 'stream-api-050', name: '0.5.0', branch: '0.5.0' }
        ],
        lastStreamId: 'stream-api-main',
        tasks: [
          {
            id: 'task-auth',
            name: 'fix-auth',
            streamId: 'stream-api-main',
            streamName: 'main',
            status,
            since: tickStart,
            ...(status === 'working' ? { activity: ACTIVITIES[tick % ACTIVITIES.length] } : {}),
            lastInteractedAt: tickStart,
            ...(status === 'attention' ? { attentionAt: tickStart } : {}),
            tabs: [
              {
                id: 'tab-chat',
                type: 'claude-chat',
                title: 'Claude',
                status,
                since: tickStart,
                ...(status === 'working' ? { activity: ACTIVITIES[tick % ACTIVITIES.length] } : {})
              },
              { id: 'tab-shell', type: 'terminal', title: 'zsh', status: 'idle' }
            ]
          },
          {
            id: 'task-docs',
            name: 'update-docs',
            streamId: 'stream-api-050',
            streamName: '0.5.0',
            status: 'exited',
            since: 1790000000000,
            lastInteractedAt: 1790000000000,
            tabs: [{ id: 'tab-pi', type: 'pi', title: 'Pi', status: 'exited', since: 1790000000000 }]
          },
          ...(land.closed ? [] : [{
            id: LAND_TASK_ID,
            name: 'login-redirect',
            streamId: 'stream-api-050',
            streamName: '0.5.0',
            status: 'idle' as const,
            lastInteractedAt: 1790000000000,
            branch: '0.5.0--login-redirect',
            ...(land.landing ? { landing: land.landing } : {}),
            tabs: [{ id: 'tab-login', type: 'claude', title: 'Claude', status: 'idle' as const }]
          }])
        ]
      },
      {
        id: 'proj-box',
        name: 'build-box',
        remote: true,
        streams: [{ id: 'stream-box-main', name: 'main', main: true }],
        tasks: [
          {
            id: 'task-ci',
            name: 'ci-flake',
            streamId: 'stream-box-main',
            streamName: 'main',
            status: tick % 2 === 0 ? 'working' : 'idle',
            ...(tick % 2 === 0 ? { activity: 'Watching CI' } : {}),
            tabs: [{ id: 'tab-codex', type: 'codex', title: 'Codex', status: tick % 2 === 0 ? 'working' : 'idle', activity: 'Watching CI' }]
          }
        ]
      }
    ]
  }
}

export class FakeDesktop {
  readonly id: string
  readonly #o: FakeDesktopOptions
  readonly #sessions = new Map<string, Session>()
  #pairings: StoredPairing[]
  #offer: LiveOffer | null = null
  #ready = false
  #tick = 0
  #land: CannedLanding = { closed: false, landing: null }
  #cancelFix: (() => void) | null = null
  readonly chat: FakeChat

  constructor(options: FakeDesktopOptions) {
    this.#o = options
    this.id = deviceId(options.identity.ed25519.pub)
    this.#pairings = [...options.pairings]
    this.chat = new FakeChat({
      tabId: CHAT_TAB_ID,
      title: 'Claude',
      now: () => this.#now(),
      schedule: options.schedule ?? ((fn, ms) => {
        const handle = setTimeout(fn, ms)
        return () => clearTimeout(handle)
      }),
      onChange: (patch) => this.#chatChanged(patch)
    })
  }

  get pairings(): readonly StoredPairing[] {
    return this.#pairings
  }

  get offer(): { uri: string; exp: number } | null {
    return this.#offer ? { uri: this.#offer.uri, exp: this.#offer.exp } : null
  }

  sessionState(phoneId: string): Session['state'] | null {
    return this.#sessions.get(phoneId)?.state ?? null
  }

  #now(): number {
    return this.#o.now ? this.#o.now() : Date.now()
  }

  handleServerMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'challenge':
        this.#o.sendRelay(buildHello({
          role: 'desktop',
          nonce: msg.nonce,
          ed25519Priv: this.#o.identity.ed25519.priv,
          ed25519Pub: this.#o.identity.ed25519.pub
        }))
        return
      case 'ready':
        if (msg.id !== this.id) this.#o.log(`relay says our id is ${msg.id}, expected ${this.id}`)
        this.#ready = true
        this.#o.log(`authenticated as desktop ${this.id}`)
        this.startOffer()
        return
      case 'frame':
        this.#handleFrame(msg.from, msg.data)
        return
      case 'peer': {
        this.#o.log(`peer ${msg.id} is ${msg.state}`)
        if (msg.state !== 'online') {
          this.#sessions.delete(msg.id)
          this.#touch(msg.id, msg.lastSeen ?? this.#now())
        }
        return
      }
      case 'error':
        this.#o.log(`relay error: ${msg.code}${msg.message ? ` (${msg.message})` : ''}${msg.to ? ` to ${msg.to}` : ''}`)
        if (msg.code === 'offline' && msg.to) this.#sessions.delete(msg.to)
        return
      case 'ping':
        this.#o.sendRelay({ t: 'pong' })
        return
      case 'pong':
        return
    }
  }

  /** The socket closed: every session dies with it (§4.2: new handshake per reconnection). */
  onDisconnected(): void {
    this.#ready = false
    this.#sessions.clear()
    this.#offer = null
  }

  /** Issues a fresh one-time secret, replacing any previous offer. */
  startOffer(): string | null {
    if (!this.#ready) return null
    const secret = this.#o.randomSecret ? this.#o.randomSecret() : toBytes(randomBytes(32))
    const exp = Math.floor(this.#now() / 1000) + PAIRING_TTL_SECONDS
    const uri = encodePairingUri({
      v: 1,
      relay: this.#o.relayUrl,
      id: this.id,
      x: b64uEncode(this.#o.identity.x25519.pub),
      e: b64uEncode(this.#o.identity.ed25519.pub),
      s: b64uEncode(secret),
      n: this.#o.name,
      exp
    })
    this.#offer = { pairProof: derivePairProof(secret), exp, uri }
    this.#o.sendRelay({ t: 'offer', tokenHash: b64uEncode(tokenHash(deriveRelayToken(secret))), exp })
    this.#o.onOffer(uri, exp)
    return uri
  }

  /** Called every few seconds: re-offers when the QR expired and pushes a changed inbox. */
  tick(): void {
    if (!this.#ready) return
    if (this.#offer && this.#now() >= this.#offer.exp * 1000) this.startOffer()
    this.#tick++
    for (const [phoneId, session] of this.#sessions) {
      if (session.state !== 'accepted') continue
      this.#sendInboxEvent(phoneId, session)
    }
  }

  #inbox(): Inbox {
    return cannedInbox({ id: this.id, name: this.#o.name }, this.#tick, this.#now(), this.#land)
  }

  /** Every accepted phone gets the inbox at once (a landing changed). */
  #broadcastInbox(): void {
    for (const [phoneId, session] of this.#sessions) {
      if (session.state === 'accepted') this.#sendInboxEvent(phoneId, session)
    }
  }

  #setLanding(landing: TaskLanding | null, closed = false): void {
    this.#land = { closed, landing }
    this.#broadcastInbox()
  }

  #sendInboxEvent(phoneId: string, session: Session): void {
    session.seq++
    this.#sendApp(phoneId, { t: 'evt', e: 'inbox', seq: session.seq, inbox: this.#inbox() })
  }

  #sendFrame(to: string, kind: FrameKind, body?: Uint8Array): void {
    this.#o.sendRelay({ t: 'frame', to, data: b64uEncode(encodeEnvelope(kind, body)) })
  }

  #sendApp(phoneId: string, message: AppMessage): void {
    const session = this.#sessions.get(phoneId)
    if (!session) return
    try {
      // Over 60000 bytes goes out as fragments (§6.1).
      for (const body of session.transport.seal(encodeJson(message))) this.#sendFrame(phoneId, FrameKind.Transport, body)
    } catch (err) {
      this.#o.log(`could not send to ${phoneId}: ${(err as Error).message}`)
    }
  }

  #handleFrame(from: string, data: string): void {
    let envelope
    try {
      envelope = decodeEnvelope(b64uDecode(data))
    } catch {
      this.#sendFrame(from, FrameKind.Reset)
      return
    }
    switch (envelope.kind) {
      case FrameKind.Handshake1:
        this.#handleHandshake(from, envelope.body)
        return
      case FrameKind.Transport:
        this.#handleTransport(from, envelope.body)
        return
      case FrameKind.Reset:
        // The phone lost its session and will send a fresh message 1.
        this.#sessions.delete(from)
        return
      case FrameKind.Handshake2:
        return
    }
  }

  #handleHandshake(from: string, message: Uint8Array): void {
    // A new handshake always replaces the old session (§4.2).
    this.#sessions.delete(from)
    const responder = createResponder({ prologue: utf8Encode(DEVTOOL_NOISE_PROLOGUE), s: this.#o.identity.x25519 })
    let payload: Uint8Array
    try {
      payload = responder.readMessage(message)
    } catch (err) {
      // Not answered with a reset: a phone with the wrong key would just loop.
      this.#o.log(`handshake from ${from} failed: ${(err as Error).message}`)
      return
    }
    const rs = responder.remoteStatic!
    let hello: PhoneHello | null = null
    let result: HandshakeResult
    try {
      const negotiation = negotiateVersion({ v: PROTOCOL_VERSION, min: MIN_PROTOCOL_VERSION }, parseHelloVersion(payload))
      if (!negotiation.ok) {
        result = 'incompatible'
      } else {
        hello = parsePhoneHello(payload)
        result = this.#decide(from, rs, hello)
      }
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err
      this.#o.log(`bad handshake payload from ${from}: ${err.message}`)
      result = 'rejected'
    }
    const reply: DesktopHello = {
      v: PROTOCOL_VERSION,
      min: MIN_PROTOCOL_VERSION,
      app: APP_VERSION,
      features: [TASK_CLOSE_FEATURE, TASK_LAND_FEATURE],
      desktopName: this.#o.name,
      result
    }
    this.#sendFrame(from, FrameKind.Handshake2, responder.writeMessage(encodeJson(reply)))
    this.#o.log(`handshake with ${from} (${hello?.deviceName ?? '?'}, ${hello?.kind ?? '?'}): ${result}`)
    if (!hello || (result !== 'ok' && result !== 'pending')) return
    const session: Session = { transport: new FramedTransport(responder.split(), { log: (line) => this.#o.log(line) }), state: result === 'ok' ? 'accepted' : 'pending', seq: 0, hello, openChat: null, chatSeq: 0 }
    this.#sessions.set(from, session)
    if (result === 'ok') this.#touch(from, this.#now())
    if (result === 'pending') void this.#ask(from, rs, session)
  }

  #decide(from: string, rs: Uint8Array, hello: PhoneHello): HandshakeResult {
    // The relay authenticated `from` by this Ed25519 key; a payload naming another key is lying.
    if (deviceId(b64uDecode(hello.ed)) !== from) return 'rejected'
    if (hello.kind === 'resume') {
      const stored = this.#pairings.find((p) => p.id === from)
      return stored && bytesEqual(b64uDecode(stored.x25519Pub), rs) ? 'ok' : 'unknown-device'
    }
    const offer = this.#offer
    if (!offer || this.#now() >= offer.exp * 1000) return 'rejected'
    if (!constantTimeEqual(b64uDecode(hello.proof!), offer.pairProof)) return 'rejected'
    // One use only: the next phone needs the next QR code.
    this.#offer = null
    return 'pending'
  }

  async #ask(phoneId: string, rs: Uint8Array, session: Session): Promise<void> {
    let accepted = false
    try {
      accepted = await this.#o.approve({ phoneId, deviceName: session.hello.deviceName, app: session.hello.app })
    } catch (err) {
      this.#o.log(`approval failed: ${(err as Error).message}`)
    }
    // The phone may have dropped or re-handshaked while we waited.
    if (this.#sessions.get(phoneId) !== session) return
    if (!accepted) {
      this.#sendApp(phoneId, { t: 'evt', e: 'pairing', status: 'rejected' })
      this.#sessions.delete(phoneId)
      this.#o.log(`rejected ${session.hello.deviceName}`)
      this.startOffer()
      return
    }
    const now = this.#now()
    this.#pairings = [
      ...this.#pairings.filter((p) => p.id !== phoneId),
      { id: phoneId, name: session.hello.deviceName, x25519Pub: b64uEncode(rs), ed25519Pub: session.hello.ed, pairedAt: now, lastSeen: now }
    ]
    this.#o.savePairings(this.#pairings)
    this.#o.sendRelay({ t: 'authorize', phone: phoneId, pub: session.hello.ed })
    session.state = 'accepted'
    this.#sendApp(phoneId, { t: 'evt', e: 'pairing', status: 'accepted' })
    this.#o.log(`paired with ${session.hello.deviceName} (${phoneId})`)
    this.startOffer()
  }

  #handleTransport(from: string, body: Uint8Array): void {
    const session = this.#sessions.get(from)
    if (!session) {
      this.#sendFrame(from, FrameKind.Reset)
      return
    }
    let plaintext: Uint8Array | null
    try {
      plaintext = session.transport.open(body)
    } catch {
      // Counters are out of step; only a new handshake can fix that.
      this.#sessions.delete(from)
      this.#sendFrame(from, FrameKind.Reset)
      return
    }
    if (!plaintext) return
    let message: AppMessage | null
    try {
      message = parseAppMessage(plaintext)
    } catch (err) {
      this.#o.log(`bad app message from ${from}: ${(err as Error).message}`)
      return
    }
    if (!message || message.t !== 'req') return
    if (session.state !== 'accepted') {
      this.#sendApp(from, { t: 'res', id: message.id, ok: false, error: { code: AppErrorCode.NotAuthorized, message: 'Pairing not accepted yet' } })
      return
    }
    if (message.op === AppOp.InboxGet) {
      this.#sendApp(from, { t: 'res', id: message.id, ok: true, result: this.#inbox() })
      return
    }
    if (message.op === AppOp.TaskClose || message.op === AppOp.TaskLand) {
      this.#handleLanding(from, session, message.id, message.op, message.params)
      return
    }
    let params
    try {
      params = parseChatParams(message.op, message.params)
    } catch (err) {
      this.#sendApp(from, { t: 'res', id: message.id, ok: false, error: { code: AppErrorCode.BadRequest, message: (err as Error).message } })
      return
    }
    if (params) {
      this.#handleChat(from, session, message.id, message.op, params)
      return
    }
    this.#sendApp(from, { t: 'res', id: message.id, ok: false, error: { code: AppErrorCode.Unsupported, message: `Unknown op ${message.op}` } })
  }

  #handleChat(from: string, session: Session, id: number, op: string, params: { tabId: string }): void {
    const fail = (code: string, text: string): void => this.#sendApp(from, { t: 'res', id, ok: false, error: { code, message: text } })
    const ok = (result: unknown): void => this.#sendApp(from, { t: 'res', id, ok: true, result })
    if (params.tabId !== CHAT_TAB_ID) {
      fail(AppErrorCode.NotFound, 'No such chat tab')
      return
    }
    const chat = this.chat
    switch (op) {
      case ChatOp.Open:
        session.openChat = CHAT_TAB_ID
        ok({ seq: session.chatSeq, view: chat.view() })
        return
      case ChatOp.Close:
        if (session.openChat === params.tabId) session.openChat = null
        ok({})
        return
      case ChatOp.Earlier: {
        const { before, limit } = params as ChatEarlierParams
        const result = chat.earlier(before, limit)
        if (result) ok(result)
        else fail(AppErrorCode.NotFound, 'No such item')
        return
      }
      case ChatOp.Send:
        ok({})
        chat.send((params as ChatSendParams).text)
        return
      case ChatOp.Answer: {
        const { promptId, answer } = params as ChatAnswerParams
        const outcome = chat.answer(promptId, answer)
        if (outcome === 'ok') ok({})
        else if (outcome === 'gone') fail(AppErrorCode.Gone, 'That prompt was already answered')
        else fail(AppErrorCode.BadRequest, 'That answer does not fit the prompt')
        return
      }
      case ChatOp.Interrupt:
        ok({})
        chat.interrupt()
        return
      case ChatOp.Detail: {
        const detail = chat.detail((params as ChatDetailParams).itemId)
        if (detail) ok(detail)
        else fail(AppErrorCode.NotFound, 'No such item')
        return
      }
    }
  }

  /**
   * `task.close` and `task.land` (§8.7, §8.15) on the canned worktree task: closing it
   * stops on a conflict; Abort clears that, Retry finds it still there, and
   * `fix-with-agent` has the "agent" land it a few seconds later, which closes it.
   * Every other task just closes.
   */
  #handleLanding(from: string, session: Session, id: number, op: string, raw: unknown): void {
    const fail = (code: string, text: string): void => this.#sendApp(from, { t: 'res', id, ok: false, error: { code, message: text } })
    const ok = (result: TaskCloseResult | TaskLandResult): void => this.#sendApp(from, { t: 'res', id, ok: true, result })
    let taskId: string
    let action: string | null = null
    try {
      if (op === AppOp.TaskClose) taskId = parseTaskCloseParams(raw).taskId
      else ({ taskId, action } = parseTaskLandParams(raw))
    } catch (err) {
      fail(AppErrorCode.BadRequest, (err as Error).message)
      return
    }
    if (taskId !== LAND_TASK_ID || this.#land.closed) {
      if (action) fail(AppErrorCode.Unsupported, 'This task has no worktree of its own')
      else ok({ closed: true })
      return
    }
    const conflict: TaskLanding = { state: 'conflict', intent: 'close', files: ['src/auth.ts', 'src/login.ts'], fileCount: 2 }
    switch (action) {
      case null: {
        const landing = this.#land.landing ?? conflict
        if (this.#land.landing?.state !== landing.state) this.#setLanding(landing)
        // A version 2 phone can't show a landing: it gets the reason as an error.
        if (Math.min(session.hello.v, PROTOCOL_VERSION) < 3) fail(AppErrorCode.Internal, 'Conflicts with 0.5.0 in 2 files. Open the task on the desktop to resolve them.')
        else ok({ closed: false, landing })
        return
      }
      case 'abort':
        this.#cancelFix?.()
        this.#setLanding(null)
        ok({ status: 'aborted' })
        return
      case 'retry':
        if (!this.#land.landing) {
          fail(AppErrorCode.Internal, 'Nothing to retry')
          return
        }
        this.#cancelFix?.()
        this.#setLanding(conflict)
        ok({ status: 'conflict', landing: conflict })
        return
      case 'fix-with-agent': {
        if (!this.#land.landing) {
          fail(AppErrorCode.Internal, 'Nothing to fix')
          return
        }
        const fixing: TaskLanding = { ...conflict, state: 'fixing' }
        this.#setLanding(fixing)
        ok({ status: 'fixing', landing: fixing })
        const schedule = this.#o.schedule ?? ((fn: () => void, ms: number) => {
          const handle = setTimeout(fn, ms)
          return () => clearTimeout(handle)
        })
        this.#cancelFix?.()
        this.#cancelFix = schedule(() => {
          this.#cancelFix = null
          this.#setLanding(null, true)
          this.#o.log('the agent fixed the conflict; login-redirect landed into 0.5.0')
        }, FIX_MS)
        return
      }
    }
  }

  /** The canned chat changed: an evt chat to every phone that has it open. */
  #chatChanged(patch: ChatPatch): void {
    const status = this.chat.status
    for (const [phoneId, session] of this.#sessions) {
      if (session.state !== 'accepted' || session.openChat !== CHAT_TAB_ID) continue
      session.chatSeq++
      this.#sendApp(phoneId, {
        t: 'evt',
        e: 'chat',
        tabId: CHAT_TAB_ID,
        seq: session.chatSeq,
        upserts: patch.upserts,
        removes: patch.removes,
        prompts: this.chat.prompts,
        ...status
      })
    }
  }

  #touch(phoneId: string, at: number): void {
    const index = this.#pairings.findIndex((p) => p.id === phoneId)
    if (index < 0) return
    this.#pairings = this.#pairings.map((p, i) => (i === index ? { ...p, lastSeen: at } : p))
    this.#o.savePairings(this.#pairings)
  }
}

import { describe, expect, it } from 'vitest'
import { FakeDesktop, cannedInbox } from '../tools/fake-desktop-core.ts'
import type { StoredPairing } from '../tools/fake-desktop-core.ts'
import {
  DEVTOOL_NOISE_PROLOGUE,
  FrameKind,
  FramedTransport,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  b64uDecode,
  b64uEncode,
  createInitiator,
  decodeEnvelope,
  decodePairingUri,
  derivePairProof,
  deriveRelayToken,
  deviceId,
  encodeEnvelope,
  encodeJson,
  generateEd25519,
  generateX25519,
  parseAppMessage,
  parseDesktopHello,
  parseInbox,
  tokenHash,
  utf8Encode
} from './index.ts'
import type { AppMessage, ChatViewEvent, ClientMessage, DesktopHello, KeyPair, PhoneHello } from './index.ts'

/**
 * Drives the fake desktop's I/O-free core with a real phone-side handshake, standing in
 * for the relay by hand. Proves the tool follows §3–§4 before the relay exists.
 */

interface Harness {
  desktop: FakeDesktop
  sent: ClientMessage[]
  offers: string[]
  pairings: StoredPairing[][]
  approve: (value: boolean) => void
  now: { value: number }
  /** Runs the canned chat's timers due within `ms`, in order, letting its awaits settle. */
  advance: (ms: number) => Promise<void>
}

function setup(options: { autoApprove?: boolean; pairings?: StoredPairing[] } = {}): Harness {
  const sent: ClientMessage[] = []
  const offers: string[] = []
  const pairings: StoredPairing[][] = []
  const now = { value: 1790000000000 }
  let resolveApproval: (value: boolean) => void = () => {}
  const timers: { at: number; fn: () => void; seq: number }[] = []
  let timerSeq = 0
  const desktop = new FakeDesktop({
    identity: { x25519: generateX25519(), ed25519: generateEd25519() },
    name: 'test-desktop',
    relayUrl: 'ws://localhost:8787',
    pairings: options.pairings ?? [],
    savePairings: (p) => pairings.push([...p]),
    sendRelay: (m) => sent.push(m),
    approve: () => (options.autoApprove === false ? new Promise((resolve) => (resolveApproval = resolve)) : Promise.resolve(true)),
    onOffer: (uri) => offers.push(uri),
    log: () => {},
    now: () => now.value,
    randomSecret: () => new Uint8Array(32).fill(offers.length + 1),
    schedule: (fn, ms) => {
      const timer = { at: now.value + ms, fn, seq: timerSeq++ }
      timers.push(timer)
      return () => { timers.splice(timers.indexOf(timer) >>> 0, timers.includes(timer) ? 1 : 0) }
    }
  })
  const advance = async (ms: number): Promise<void> => {
    const until = now.value + ms
    await flush()
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq)
      const next = timers[0]
      if (!next || next.at > until) break
      timers.shift()
      now.value = next.at
      next.fn()
      await flush()
    }
    now.value = until
  }
  return { desktop, sent, offers, pairings, approve: (v) => resolveApproval(v), now, advance }
}

function connect(h: Harness): void {
  h.desktop.handleServerMessage({ t: 'challenge', nonce: b64uEncode(new Uint8Array(32)) })
  expect(h.sent.at(-1)).toMatchObject({ t: 'hello', role: 'desktop' })
  h.desktop.handleServerMessage({ t: 'ready', id: h.desktop.id })
}

class Phone {
  readonly x: KeyPair = generateX25519()
  readonly ed: KeyPair = generateEd25519()
  readonly id = deviceId(this.ed.pub)
  transport: FramedTransport | null = null
  #pending: ReturnType<typeof createInitiator> | null = null

  hello(kind: 'pair' | 'resume', secret?: Uint8Array): PhoneHello {
    return {
      v: PROTOCOL_VERSION, min: MIN_PROTOCOL_VERSION, app: 'ios/test', features: [], kind, deviceName: 'Test iPhone', ed: b64uEncode(this.ed.pub),
      ...(secret ? { proof: b64uEncode(derivePairProof(secret)) } : {})
    }
  }

  message1(desktopX: Uint8Array, payload: PhoneHello | Uint8Array): string {
    this.#pending = createInitiator({ prologue: utf8Encode(DEVTOOL_NOISE_PROLOGUE), s: this.x, rs: desktopX })
    const body = this.#pending.writeMessage(payload instanceof Uint8Array ? payload : encodeJson(payload))
    return b64uEncode(encodeEnvelope(FrameKind.Handshake1, body))
  }

  message2(data: string): DesktopHello {
    const env = decodeEnvelope(b64uDecode(data))
    expect(env.kind).toBe(FrameKind.Handshake2)
    const hello = parseDesktopHello(this.#pending!.readMessage(env.body))
    this.transport = new FramedTransport(this.#pending!.split())
    return hello
  }

  send(message: AppMessage): string {
    const [body] = this.transport!.seal(encodeJson(message))
    return b64uEncode(encodeEnvelope(FrameKind.Transport, body))
  }

  receive(data: string): AppMessage | null {
    const env = decodeEnvelope(b64uDecode(data))
    expect(env.kind).toBe(FrameKind.Transport)
    const plaintext = this.transport!.open(env.body)
    return plaintext ? parseAppMessage(plaintext) : null
  }
}

function frames(h: Harness, to: string): string[] {
  return h.sent.flatMap((m) => (m.t === 'frame' && m.to === to ? [m.data] : []))
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function pair(h: Harness, phone: Phone): Promise<DesktopHello> {
  const qr = decodePairingUri(h.offers.at(-1)!)
  const before = frames(h, phone.id).length
  h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.message1(b64uDecode(qr.x), phone.hello('pair', b64uDecode(qr.s))) })
  const reply = phone.message2(frames(h, phone.id)[before])
  await flush()
  return reply
}

describe('fake desktop', () => {
  it('authenticates, then offers a pairing link whose token hash matches the offer', () => {
    const h = setup()
    connect(h)
    const offer = h.sent.find((m) => m.t === 'offer')
    const qr = decodePairingUri(h.offers[0])
    expect(qr.id).toBe(h.desktop.id)
    expect(offer).toEqual({ t: 'offer', tokenHash: b64uEncode(tokenHash(deriveRelayToken(b64uDecode(qr.s)))), exp: 1790000300 })
  })

  it('pairs, authorizes at the relay, then serves the inbox and pushes changes', async () => {
    const h = setup()
    connect(h)
    const phone = new Phone()
    const reply = await pair(h, phone)
    expect(reply).toMatchObject({ result: 'pending', desktopName: 'test-desktop' })
    expect(h.sent).toContainEqual({ t: 'authorize', phone: phone.id, pub: b64uEncode(phone.ed.pub) })
    expect(h.pairings.at(-1)).toEqual([expect.objectContaining({ id: phone.id, x25519Pub: b64uEncode(phone.x.pub), name: 'Test iPhone' })])
    const out = frames(h, phone.id)
    expect(phone.receive(out[1])).toEqual({ t: 'evt', e: 'pairing', status: 'accepted' })
    // The used offer is replaced by a fresh one.
    expect(h.offers).toHaveLength(2)

    h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.send({ t: 'req', id: 1, op: 'inbox.get' }) })
    const res = phone.receive(frames(h, phone.id).at(-1)!)
    expect(res).toMatchObject({ t: 'res', id: 1, ok: true })
    expect(parseInbox((res as { result: unknown }).result).desktop).toEqual({ id: h.desktop.id, name: 'test-desktop' })

    h.desktop.tick()
    h.desktop.tick()
    const e1 = phone.receive(frames(h, phone.id).at(-2)!)
    const e2 = phone.receive(frames(h, phone.id).at(-1)!)
    expect(e1).toMatchObject({ t: 'evt', e: 'inbox', seq: 1 })
    expect(e2).toMatchObject({ t: 'evt', e: 'inbox', seq: 2 })

    h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.send({ t: 'req', id: 2, op: 'chat.fly' }) })
    expect(phone.receive(frames(h, phone.id).at(-1)!)).toMatchObject({ t: 'res', id: 2, ok: false, error: { code: 'unsupported' } })
  })

  it('refuses a reused or wrong proof', async () => {
    const h = setup()
    connect(h)
    const qr = decodePairingUri(h.offers[0])
    const phone = new Phone()
    h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.message1(b64uDecode(qr.x), phone.hello('pair', new Uint8Array(32).fill(99))) })
    expect(phone.message2(frames(h, phone.id)[0]).result).toBe('rejected')

    await pair(h, new Phone())
    const late = new Phone()
    h.desktop.handleServerMessage({ t: 'frame', from: late.id, data: late.message1(b64uDecode(qr.x), late.hello('pair', b64uDecode(qr.s))) })
    expect(late.message2(frames(h, late.id)[0]).result).toBe('rejected')
  })

  it('refuses an expired offer', () => {
    const h = setup()
    connect(h)
    const qr = decodePairingUri(h.offers[0])
    h.now.value += 301_000
    const phone = new Phone()
    h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.message1(b64uDecode(qr.x), phone.hello('pair', b64uDecode(qr.s))) })
    expect(phone.message2(frames(h, phone.id)[0]).result).toBe('rejected')
  })

  it('holds a pending phone until the user decides, and tells it when rejected', async () => {
    const h = setup({ autoApprove: false })
    connect(h)
    const phone = new Phone()
    expect((await pair(h, phone)).result).toBe('pending')
    expect(h.desktop.sessionState(phone.id)).toBe('pending')
    h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.send({ t: 'req', id: 1, op: 'inbox.get' }) })
    expect(phone.receive(frames(h, phone.id).at(-1)!)).toMatchObject({ ok: false, error: { code: 'not-authorized' } })
    h.desktop.tick()
    expect(frames(h, phone.id)).toHaveLength(2)
    h.approve(false)
    await flush()
    expect(phone.receive(frames(h, phone.id).at(-1)!)).toEqual({ t: 'evt', e: 'pairing', status: 'rejected' })
    expect(h.sent.some((m) => m.t === 'authorize')).toBe(false)
    expect(h.desktop.sessionState(phone.id)).toBeNull()
  })

  it('resumes a stored pairing and refuses an unknown one', () => {
    const phone = new Phone()
    const stored: StoredPairing = {
      id: phone.id, name: 'Test iPhone', x25519Pub: b64uEncode(phone.x.pub), ed25519Pub: b64uEncode(phone.ed.pub), pairedAt: 1, lastSeen: null
    }
    const h = setup({ pairings: [stored] })
    connect(h)
    const x = b64uDecode(decodePairingUri(h.offers[0]).x)
    h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.message1(x, phone.hello('resume')) })
    expect(phone.message2(frames(h, phone.id)[0]).result).toBe('ok')
    expect(h.desktop.sessionState(phone.id)).toBe('accepted')

    const stranger = new Phone()
    h.desktop.handleServerMessage({ t: 'frame', from: stranger.id, data: stranger.message1(x, stranger.hello('resume')) })
    expect(stranger.message2(frames(h, stranger.id)[0]).result).toBe('unknown-device')
    expect(h.desktop.sessionState(stranger.id)).toBeNull()
  })

  it('rejects a phone whose payload names a different Ed25519 key than the relay authenticated', () => {
    const h = setup()
    connect(h)
    const qr = decodePairingUri(h.offers[0])
    const phone = new Phone()
    h.desktop.handleServerMessage({ t: 'frame', from: 'f'.repeat(32), data: phone.message1(b64uDecode(qr.x), phone.hello('pair', b64uDecode(qr.s))) })
    expect(phone.message2(frames(h, 'f'.repeat(32))[0]).result).toBe('rejected')
  })

  it('answers incompatible for a phone that is too new', () => {
    const h = setup()
    connect(h)
    const phone = new Phone()
    const x = b64uDecode(decodePairingUri(h.offers[0]).x)
    h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.message1(x, utf8Encode('{"v":9,"min":9}')) })
    expect(phone.message2(frames(h, phone.id)[0]).result).toBe('incompatible')
  })

  it('replies reset to transport frames without a session or that fail to decrypt', async () => {
    const h = setup()
    connect(h)
    const phone = new Phone()
    h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: b64uEncode(encodeEnvelope(FrameKind.Transport, new Uint8Array(20))) })
    expect(decodeEnvelope(b64uDecode(frames(h, phone.id)[0])).kind).toBe(FrameKind.Reset)

    await pair(h, phone)
    h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: b64uEncode(encodeEnvelope(FrameKind.Transport, new Uint8Array(20))) })
    expect(decodeEnvelope(b64uDecode(frames(h, phone.id).at(-1)!)).kind).toBe(FrameKind.Reset)
    expect(h.desktop.sessionState(phone.id)).toBeNull()
  })

  it('drops sessions on peer offline and on disconnect', async () => {
    const h = setup()
    connect(h)
    const phone = new Phone()
    await pair(h, phone)
    h.desktop.handleServerMessage({ t: 'peer', id: phone.id, state: 'offline', lastSeen: 5 })
    expect(h.desktop.sessionState(phone.id)).toBeNull()
    expect(h.desktop.pairings[0].lastSeen).toBe(5)
    h.desktop.onDisconnected()
    expect(h.desktop.offer).toBeNull()
  })
})

describe('fake desktop task worktree', () => {
  async function paired(v = PROTOCOL_VERSION) {
    const h = setup()
    connect(h)
    const phone = new Phone()
    const qr = decodePairingUri(h.offers.at(-1)!)
    const hello = { ...phone.hello('pair', b64uDecode(qr.s)), v, min: Math.min(v, MIN_PROTOCOL_VERSION) }
    h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.message1(b64uDecode(qr.x), hello) })
    const reply = phone.message2(frames(h, phone.id)[0])
    await flush()
    // Message 2 isn't a transport frame; everything after it is decrypted in order.
    let seen = 1
    const inbound = (): AppMessage[] => {
      const out = frames(h, phone.id).slice(seen).map((f) => phone.receive(f)).filter((m): m is AppMessage => m !== null)
      seen = frames(h, phone.id).length
      return out
    }
    const req = (id: number, op: string, params: unknown): AppMessage[] => {
      h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.send({ t: 'req', id, op, params }) })
      return inbound()
    }
    inbound()
    return { h, reply, req, inbound }
  }
  const landTask = (m: AppMessage) => m.t === 'evt' && m.e === 'inbox' ? m.inbox.projects[0].tasks.find((t) => t.id === 'task-login') : undefined

  it('stops a close on a conflict, then lands it through the agent (§8.7, §8.15)', async () => {
    const { h, reply, req } = await paired()
    expect(reply.features).toEqual(['task.close', 'task.land'])
    expect(req(1, 'task.land', { taskId: 'task-login', action: 'retry' }).at(-1)).toMatchObject({ ok: false, error: { code: 'internal' } })
    const closing = req(2, 'task.close', { taskId: 'task-login' })
    expect(landTask(closing[0])).toMatchObject({ branch: '0.5.0--login-redirect', landing: { state: 'conflict', fileCount: 2 } })
    expect(closing.at(-1)).toMatchObject({ t: 'res', id: 2, ok: true, result: { closed: false, landing: { state: 'conflict', files: ['src/auth.ts', 'src/login.ts'] } } })
    expect(req(3, 'task.land', { taskId: 'task-login', action: 'abort' }).at(-1)).toMatchObject({ ok: true, result: { status: 'aborted' } })
    req(4, 'task.close', { taskId: 'task-login' })
    expect(req(5, 'task.land', { taskId: 'task-login', action: 'retry' }).at(-1)).toMatchObject({ ok: true, result: { status: 'conflict' } })
    const fixing = req(6, 'task.land', { taskId: 'task-login', action: 'fix-with-agent' })
    expect(landTask(fixing[0])?.landing?.state).toBe('fixing')
    expect(fixing.at(-1)).toMatchObject({ ok: true, result: { status: 'fixing', landing: { state: 'fixing' } } })
    await h.advance(3000)
    const landed = req(7, 'inbox.get', null).at(-1) as { result: { projects: { tasks: { id: string }[] }[] } }
    expect(landed.result.projects[0].tasks.map((t) => t.id)).not.toContain('task-login')
    expect(req(8, 'task.land', { taskId: 'task-login', action: 'abort' }).at(-1)).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(req(9, 'task.land', { taskId: 'task-login', action: 'merge' }).at(-1)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('answers a conflicting close from a version 2 phone with an error it can show', async () => {
    const { req } = await paired(2)
    expect(req(1, 'task.close', { taskId: 'task-login' }).at(-1)).toMatchObject({ ok: false, error: { code: 'internal', message: expect.stringContaining('Conflicts with 0.5.0') } })
  })
})

describe('cannedInbox', () => {
  it('is a valid Inbox whose first tab changes every tick', () => {
    const desktop = { id: 'a'.repeat(32), name: 'd' }
    const statuses = new Set<string>()
    for (let tick = 0; tick < 5; tick++) {
      const inbox = cannedInbox(desktop, tick, 1790000000000 + tick * 5000)
      expect(parseInbox(JSON.parse(JSON.stringify(inbox)))).toEqual(inbox)
      statuses.add(inbox.projects[0].tasks[0].tabs[0].status)
    }
    expect([...statuses].sort()).toEqual(['attention', 'exited', 'idle', 'working'])
  })

  it('serves a canned chat: streams a reply, then permission, question and plan prompts that change the transcript', async () => {
    const h = setup()
    connect(h)
    const phone = new Phone()
    // Skip message 2; the pairing event after it is the first transport message.
    let seen = frames(h, phone.id).length + 1
    await pair(h, phone)
    const inbound = (): AppMessage[] => {
      const out = frames(h, phone.id).slice(seen).map((f) => phone.receive(f)).filter((m): m is AppMessage => m !== null)
      seen = frames(h, phone.id).length
      return out
    }
    const req = (id: number, op: string, params: unknown): void => {
      h.desktop.handleServerMessage({ t: 'frame', from: phone.id, data: phone.send({ t: 'req', id, op, params }) })
    }
    inbound()

    req(1, 'chat.open', { tabId: 'tab-shell' })
    expect(inbound()).toEqual([{ t: 'res', id: 1, ok: false, error: { code: 'not-found', message: 'No such chat tab' } }])
    req(2, 'chat.open', { tabId: 'tab-chat' })
    const [open] = inbound() as { result: { seq: number; view: { items: { id: string }[]; hasEarlier: boolean } } }[]
    expect(open.result.seq).toBe(0)
    expect(open.result.view.items).toHaveLength(60)
    expect(open.result.view.hasEarlier).toBe(true)
    req(3, 'chat.earlier', { tabId: 'tab-chat', before: open.result.view.items[0].id })
    const [earlier] = inbound() as { result: { hasEarlier: boolean; items: { id: string }[] } }[]
    expect(earlier.result.hasEarlier).toBe(false)
    expect(earlier.result.items[0].id).toBe('h-u1')
    expect(earlier.result.items.length + 60).toBe(73)

    req(4, 'chat.send', { tabId: 'tab-chat', text: 'Fix the auth bug' })
    await h.advance(4000)
    const events = inbound().filter((m): m is ChatViewEvent => m.t === 'evt' && m.e === 'chat')
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
    const streamed = events.flatMap((e) => e.upserts).filter((i) => i.kind === 'text' && i.streaming)
    expect(streamed.length).toBeGreaterThan(5)
    const permission = events.at(-1)!.prompts[0]
    expect(permission).toMatchObject({ kind: 'permission', toolName: 'Bash', canAlwaysAllow: true })
    expect(events.at(-1)!.busy).toBe(true)

    req(5, 'chat.answer', { tabId: 'tab-chat', promptId: permission.id, answer: { behavior: 'allow' } })
    req(6, 'chat.answer', { tabId: 'tab-chat', promptId: permission.id, answer: { behavior: 'allow' } })
    await h.advance(2000)
    let msgs = inbound()
    expect(msgs.find((m) => m.t === 'res' && m.id === 6)).toMatchObject({ ok: false, error: { code: 'gone' } })
    const question = (msgs.filter((m) => m.t === 'evt').at(-1) as ChatViewEvent).prompts[0]
    expect(question.kind).toBe('question')
    if (question.kind !== 'question') return
    const answers = Object.fromEntries(question.questions.map((q) => [q.question, q.multiSelect ? 'Changelog entry, Metrics' : 'Postgres']))
    req(7, 'chat.answer', { tabId: 'tab-chat', promptId: question.id, answer: { behavior: 'approvePlan' } })
    req(8, 'chat.answer', { tabId: 'tab-chat', promptId: question.id, answer: { behavior: 'answers', answers } })
    await h.advance(100)
    msgs = inbound()
    expect(msgs.find((m) => m.t === 'res' && m.id === 7)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const afterAnswer = msgs.filter((m): m is ChatViewEvent => m.t === 'evt' && m.e === 'chat')
    expect(afterAnswer.flatMap((e) => e.upserts).some((i) => i.kind === 'text' && i.markdown.includes('Postgres') && i.markdown.includes('Metrics'))).toBe(true)
    const plan = afterAnswer.at(-1)!.prompts[0]
    expect(plan.kind).toBe('plan')

    req(9, 'chat.answer', { tabId: 'tab-chat', promptId: plan.id, answer: { behavior: 'approvePlan' } })
    await h.advance(1000)
    const done = inbound().filter((m): m is ChatViewEvent => m.t === 'evt' && m.e === 'chat')
    expect(done.at(-1)).toMatchObject({ busy: false, prompts: [] })
    expect(done.flatMap((e) => e.upserts).some((i) => i.kind === 'text' && i.markdown.startsWith('Plan approved'))).toBe(true)

    // `long` needs fragmentation for both the event and the detail.
    const before = frames(h, phone.id).length
    req(10, 'chat.send', { tabId: 'tab-chat', text: 'long' })
    msgs = inbound()
    expect(frames(h, phone.id).length - before).toBeGreaterThan(msgs.length)
    const long = msgs.filter((m): m is ChatViewEvent => m.t === 'evt' && m.e === 'chat').flatMap((e) => e.upserts)
    const tool = long.find((i) => i.kind === 'tool')!
    req(11, 'chat.detail', { tabId: 'tab-chat', itemId: tool.id })
    const [detail] = inbound() as { result: { kind: string; result: string } }[]
    expect(detail.result.result.length).toBeGreaterThan(150_000)

    // Interrupt mid-turn, then close: no more events.
    req(12, 'chat.send', { tabId: 'tab-chat', text: 'again' })
    await h.advance(500)
    req(13, 'chat.interrupt', { tabId: 'tab-chat' })
    const stopped = inbound().filter((m): m is ChatViewEvent => m.t === 'evt' && m.e === 'chat').at(-1)!
    expect(stopped.busy).toBe(false)
    expect(stopped.upserts.at(-1)).toMatchObject({ kind: 'notice', text: 'Interrupted' })
    req(14, 'chat.close', { tabId: 'tab-chat' })
    req(15, 'chat.send', { tabId: 'tab-chat', text: 'reset' })
    await h.advance(5000)
    expect(inbound().filter((m) => m.t === 'evt' && m.e === 'chat')).toEqual([])
    h.desktop.chat.dispose()
  })
})

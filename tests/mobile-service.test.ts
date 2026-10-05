import { describe, expect, it } from 'vitest'
import {
  INBOX_THROTTLE_MS,
  MobileService,
  type ChannelHooks,
  type MobileServiceDeps,
  type MobileTimers,
  type PairingInvite,
  type PhoneChannel,
  type RelayTransport,
  type RelayTransportState,
  type DesktopAppMessage,
  type RelayDesktopMessage,
  type RelayServerMessage,
  type VerifiedHello
} from '../src/main/mobile/mobile-service'
import type { MobilePairing, MobilePushRegistration } from '../src/main/mobile/pairings-store'
import { b64uEncode, deviceId, type PhoneHello } from '../protocol/ts/index.ts'
import { DEFAULT_MOBILE_CONFIG, type MobileConfig, type MobileState } from '../src/shared/mobile'
import { createHomeTask, type ProjectsData, type TabStatusValue } from '../src/shared/types'

// ---- fakes -------------------------------------------------------------------

class FakeTimers implements MobileTimers {
  current = 1_000_000
  private seq = 0
  private tasks = new Map<number, { at: number; fn: () => void }>()
  now = () => this.current
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq
    this.tasks.set(id, { at: this.current + ms, fn })
    return id
  }
  clearTimeout = (handle: unknown) => { this.tasks.delete(handle as number) }
  advance(ms: number): void {
    const until = this.current + ms
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.tasks.delete(due[0])
      this.current = due[1].at
      due[1].fn()
    }
    this.current = until
  }
  get pending(): number { return this.tasks.size }
}

class FakeTransport implements RelayTransport {
  state: RelayTransportState = { kind: 'idle' }
  sent: RelayDesktopMessage[] = []
  connectedTo: string[] = []
  closed = false
  private messageListeners = new Set<(m: RelayServerMessage) => void>()
  private stateListeners = new Set<(s: RelayTransportState) => void>()
  connect(url: string): void { this.connectedTo.push(url); this.setState({ kind: 'connecting' }) }
  close(): void { this.closed = true; this.state = { kind: 'idle' } }
  send(m: RelayDesktopMessage): boolean {
    if (this.state.kind !== 'online') return false
    this.sent.push(m)
    return true
  }
  getState(): RelayTransportState { return this.state }
  onMessage(l: (m: RelayServerMessage) => void) { this.messageListeners.add(l); return () => this.messageListeners.delete(l) }
  onStateChange(l: (s: RelayTransportState) => void) { this.stateListeners.add(l); return () => this.stateListeners.delete(l) }
  setState(s: RelayTransportState): void { this.state = s; for (const l of this.stateListeners) l(s) }
  deliver(m: RelayServerMessage): void { for (const l of this.messageListeners) l(m) }
}

class FakeChannel implements PhoneChannel {
  established = false
  sent: DesktopAppMessage[] = []
  received: Uint8Array[] = []
  closed = false
  lastResult: string | null = null
  constructor(readonly phoneId: string, readonly hooks: ChannelHooks) {}
  receive(data: Uint8Array): void { this.received.push(data) }
  send(m: DesktopAppMessage): boolean {
    if (!this.established || this.closed) return false
    this.sent.push(m)
    return true
  }
  close(): void { this.closed = true }
  /** Simulate a complete handshake. */
  handshake(hello: VerifiedHello): string {
    const result = this.hooks.onHello(hello)
    this.lastResult = result
    if (result === 'ok' || result === 'pending') {
      this.established = true
      this.hooks.onEstablished(result)
    }
    return result
  }
  inboxEvents() { return this.sent.filter((m): m is Extract<DesktopAppMessage, { e: 'inbox' }> => m.t === 'evt' && m.e === 'inbox') }
}

class FakePairings {
  items: MobilePairing[] = []
  list() { return this.items.map(p => ({ ...p })) }
  get(id: string) { const p = this.items.find(x => x.id === id); return p ? { ...p } : null }
  add(p: MobilePairing) { this.items = [...this.items.filter(x => x.id !== p.id), p] }
  remove(id: string) { const n = this.items.length; this.items = this.items.filter(x => x.id !== id); return n !== this.items.length }
  touchLastSeen(id: string, at: number) { this.items = this.items.map(p => p.id === id ? { ...p, lastSeen: at } : p) }
  setPush(id: string, push: MobilePushRegistration | null) {
    if (!this.items.some(p => p.id === id)) return false
    this.items = this.items.map(p => {
      if (p.id !== id) return p
      const { push: _old, ...rest } = p
      return push ? { ...rest, push } : rest
    })
    return true
  }
  revokes: string[] = []
  pendingRevokes() { return [...this.revokes] }
  setPendingRevoke(id: string, pending: boolean) {
    this.revokes = this.revokes.filter(r => r !== id)
    if (pending) this.revokes.push(id)
  }
}

const b64u = b64uEncode

function phoneKeys(seed: number) {
  const ed = new Uint8Array(32).fill(seed)
  const x = new Uint8Array(32).fill(seed + 100)
  return { id: deviceId(ed), ed: b64u(ed), x: b64u(x), xBytes: x }
}

const PROOF = new Uint8Array(32).fill(7)
const PROOF_B64 = b64u(PROOF)

function hello(
  keys: ReturnType<typeof phoneKeys>,
  extra: Partial<PhoneHello> = {},
  remoteStatic: Uint8Array = keys.xBytes
): VerifiedHello {
  return {
    hello: { v: 1, min: 1, app: 'ios/0.1.0', features: [], kind: 'resume', deviceName: 'Test iPhone', ed: keys.ed, ...extra },
    remoteStatic
  }
}

function setup(options: { enabled?: boolean; projects?: ProjectsData; newChat?: MobileServiceDeps['newChat']; newTask?: MobileServiceDeps['newTask']; closeTask?: MobileServiceDeps['closeTask']; closeTab?: MobileServiceDeps['closeTab']; setPin?: MobileServiceDeps['setPin']; triageTask?: MobileServiceDeps['triageTask']; chat?: MobileServiceDeps['chat'] } = {}) {
  const timers = new FakeTimers()
  let config: MobileConfig = { ...DEFAULT_MOBILE_CONFIG, enabled: options.enabled ?? false }
  let projects: ProjectsData = options.projects ?? {
    projects: [{
      id: 'p1', name: 'api', directory: '/x',
      tasks: [createHomeTask('p1').task, {
        id: 't1', name: 'fix', tabs: { left: [{ id: 'tab1', type: 'claude', title: 'Claude' }], right: [] },
        activeTab: { left: 'tab1', right: null }, splitOpen: false, splitRatio: 0.5
      }]
    }],
    tags: [], projectOrder: ['p1'], pinnedItems: []
  }
  const statuses: Record<string, TabStatusValue> = {}
  const projectListeners = new Set<() => void>()
  const activityListeners = new Set<(tabId: string) => void>()
  const transports: FakeTransport[] = []
  const channels: FakeChannel[] = []
  const states: MobileState[] = []
  const pairings = new FakePairings()
  const invites: PairingInvite[] = []

  const deps: MobileServiceDeps = {
    getConfig: () => config,
    saveConfig: (next) => { config = next },
    projects: {
      peek: () => projects,
      subscribe: (l) => { projectListeners.add(l); return () => projectListeners.delete(l) }
    },
    activity: {
      getStatus: (id) => statuses[id] ?? null,
      getActivity: () => null,
      getSince: () => null,
      subscribe: (l) => { activityListeners.add(l); return () => activityListeners.delete(l) }
    },
    pairings,
    getDesktopId: () => 'd'.repeat(32),
    defaultDesktopName: () => 'host',
    createTransport: () => { const t = new FakeTransport(); transports.push(t); return t },
    channels: { create: (phoneId, hooks) => { const c = new FakeChannel(phoneId, hooks); channels.push(c); return c } },
    createInvite: ({ now }) => {
      const invite = { uri: `devtool://pair?d=${invites.length}`, exp: Math.floor(now / 1000) + 300, tokenHash: `hash${invites.length}`, pairProof: PROOF }
      invites.push(invite)
      return invite
    },
    broadcastState: (s) => states.push(s),
    log: () => {},
    timers,
    newChat: options.newChat,
    newTask: options.newTask,
    closeTask: options.closeTask,
    closeTab: options.closeTab,
    setPin: options.setPin,
    triageTask: options.triageTask,
    chat: options.chat
  }
  const service = new MobileService(deps)
  const transport = () => transports[transports.length - 1]
  return {
    service, timers, transports, transport, channels, states, pairings, invites, statuses,
    config: () => config,
    setProjects: (next: ProjectsData) => { projects = next; for (const l of projectListeners) l() },
    setStatus: (tabId: string, status: TabStatusValue) => { statuses[tabId] = status; for (const l of activityListeners) l(tabId) },
    listenerCount: () => projectListeners.size + activityListeners.size,
    /** A frame from `phoneId` makes the service create its channel. */
    frameFrom: (phoneId: string) => {
      transport().deliver({ t: 'frame', from: phoneId, data: b64u(new Uint8Array([1, 2, 3])) })
      return channels.find(c => c.phoneId === phoneId && !c.closed)!
    }
  }
}

function pairedSetup(options: { newChat?: MobileServiceDeps['newChat']; newTask?: MobileServiceDeps['newTask']; closeTask?: MobileServiceDeps['closeTask']; closeTab?: MobileServiceDeps['closeTab']; setPin?: MobileServiceDeps['setPin']; triageTask?: MobileServiceDeps['triageTask']; chat?: MobileServiceDeps['chat'] } = {}) {
  const env = setup({ enabled: true, ...options })
  const keys = phoneKeys(1)
  env.pairings.add({ id: keys.id, name: 'Phone', x25519Pub: keys.x, ed25519Pub: keys.ed, pairedAt: 1, lastSeen: null })
  env.service.start()
  env.transport().setState({ kind: 'online' })
  const channel = env.frameFrom(keys.id)
  expect(channel.handshake(hello(keys))).toBe('ok')
  return { ...env, keys, channel }
}

// ---- tests -------------------------------------------------------------------

describe('MobileService state', () => {
  it('stays disabled and connects nowhere while Mobile is off', () => {
    const env = setup()
    env.service.start()
    expect(env.transports).toHaveLength(0)
    expect(env.service.getState().connection).toEqual({ kind: 'disabled' })
    expect(env.states.at(-1)?.enabled).toBe(false)
  })

  it('connects on start when enabled and follows the transport state', () => {
    const env = setup({ enabled: true })
    env.service.start()
    expect(env.transport().connectedTo).toEqual([DEFAULT_MOBILE_CONFIG.relayUrl])
    expect(env.service.getState().connection).toEqual({ kind: 'connecting' })
    env.transport().setState({ kind: 'online' })
    expect(env.states.at(-1)?.connection).toEqual({ kind: 'online' })
    env.transport().setState({ kind: 'offline', error: 'ECONNREFUSED' })
    expect(env.states.at(-1)?.connection).toEqual({ kind: 'offline', error: 'ECONNREFUSED' })
  })

  it('enable persists the config and connects; disable closes the transport', () => {
    const env = setup()
    env.service.start()
    env.service.setEnabled(true)
    expect(env.config().enabled).toBe(true)
    expect(env.transports).toHaveLength(1)
    env.service.setEnabled(false)
    expect(env.config().enabled).toBe(false)
    expect(env.transports[0].closed).toBe(true)
    expect(env.states.at(-1)?.connection).toEqual({ kind: 'disabled' })
  })

  it('does not broadcast identical states twice', () => {
    const env = setup()
    env.service.start()
    const count = env.states.length
    env.service.setEnabled(false)
    env.service.cancelPairing()
    expect(env.states.length).toBe(count)
  })

  it('changing the relay URL reconnects to the new one and drops the QR code', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    await env.service.startPairing()
    env.service.setRelayUrl('ws://localhost:8787/')
    expect(env.config().relayUrl).toBe('ws://localhost:8787')
    expect(env.transports[0].closed).toBe(true)
    expect(env.transport().connectedTo).toEqual(['ws://localhost:8787'])
    expect(env.service.getState().invite).toBeNull()
  })

  it('stop unsubscribes and closes everything', () => {
    const env = setup({ enabled: true })
    env.service.start()
    expect(env.listenerCount()).toBe(2)
    env.service.stop()
    expect(env.listenerCount()).toBe(0)
    expect(env.transport().closed).toBe(true)
  })
})

describe('MobileService pairing', () => {
  it('startPairing turns Mobile on, returns the invite and offers it once online', async () => {
    const env = setup()
    env.service.start()
    const invite = await env.service.startPairing()
    expect(env.config().enabled).toBe(true)
    expect(invite).toEqual({ uri: env.invites[0].uri, exp: env.invites[0].exp })
    expect(env.service.getState().invite).toEqual(invite)
    expect(env.transport().sent).toEqual([])
    env.transport().setState({ kind: 'online' })
    expect(env.transport().sent).toEqual([{ t: 'offer', tokenHash: 'hash0', exp: invite.exp }])
  })

  it('a new code replaces the old one; cancel clears it', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    await env.service.startPairing()
    const second = await env.service.startPairing()
    expect(env.service.getState().invite?.uri).toBe(second.uri)
    expect(env.transport().sent.map(m => m.t)).toEqual(['offer', 'offer'])
    env.service.cancelPairing()
    expect(env.service.getState().invite).toBeNull()
  })

  it('the code expires on its own', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    await env.service.startPairing()
    env.timers.advance(299_000)
    expect(env.service.getState().invite).not.toBeNull()
    env.timers.advance(2_000)
    expect(env.service.getState().invite).toBeNull()
    expect(env.states.at(-1)?.invite).toBeNull()
  })

  it('a phone with the right proof becomes a pending request; accept pairs it', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    await env.service.startPairing()
    const keys = phoneKeys(2)
    const channel = env.frameFrom(keys.id)
    expect(channel.received).toHaveLength(1)
    expect(channel.handshake(hello(keys, { kind: 'pair', proof: PROOF_B64, deviceName: 'Vlad iPhone' }))).toBe('pending')

    const state = env.service.getState()
    expect(state.pending).toMatchObject({ phoneId: keys.id, name: 'Vlad iPhone' })
    expect(state.invite).toBeNull() // single use

    // Nothing but a refusal before Accept.
    channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'inbox.get' })
    expect(channel.sent.at(-1)).toMatchObject({ t: 'res', id: 1, ok: false, error: { code: 'not-authorized' } })

    env.service.accept(keys.id)
    expect(env.pairings.get(keys.id)).toMatchObject({ name: 'Vlad iPhone', x25519Pub: keys.x, ed25519Pub: keys.ed })
    expect(env.transport().sent.at(-1)).toEqual({ t: 'authorize', phone: keys.id, pub: keys.ed })
    expect(channel.sent.slice(-2).map(m => m.t === 'evt' ? m.e : m.t)).toEqual(['pairing', 'inbox'])
    expect(channel.sent.at(-2)).toEqual({ t: 'evt', e: 'pairing', status: 'accepted' })
    expect(env.service.getState().pending).toBeNull()
    expect(env.service.getState().devices.map(d => d.id)).toEqual([keys.id])
  })

  it('reject tells the phone and stores nothing', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    await env.service.startPairing()
    const keys = phoneKeys(3)
    const channel = env.frameFrom(keys.id)
    channel.handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))
    env.service.reject(keys.id)
    expect(channel.sent.at(-1)).toEqual({ t: 'evt', e: 'pairing', status: 'rejected' })
    expect(env.pairings.items).toEqual([])
    expect(env.service.getState().pending).toBeNull()
    expect(() => env.service.accept(keys.id)).toThrow()
  })

  it('refuses a wrong proof, an expired code, or no code at all', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    const keys = phoneKeys(4)
    expect(env.frameFrom(keys.id).handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))).toBe('rejected')
    await env.service.startPairing()
    expect(env.channels[0].handshake(hello(keys, { kind: 'pair', proof: b64u(new Uint8Array(32)) }))).toBe('rejected')
    env.timers.advance(301_000)
    expect(env.channels[0].handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))).toBe('rejected')
    expect(env.service.getState().pending).toBeNull()
  })

  it('refuses a payload key that does not match the relay-authenticated phone id', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    await env.service.startPairing()
    const keys = phoneKeys(5)
    const other = phoneKeys(6)
    expect(env.frameFrom(keys.id).handshake(hello(other, { kind: 'pair', proof: PROOF_B64 }))).toBe('rejected')
    expect(env.service.getState().invite).not.toBeNull() // a refused phone does not use up the code
  })

  it('resume: ok for a stored pairing, unknown-device otherwise', () => {
    const env = setup({ enabled: true })
    const keys = phoneKeys(7)
    env.pairings.add({ id: keys.id, name: 'P', x25519Pub: keys.x, ed25519Pub: keys.ed, pairedAt: 1, lastSeen: null })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    const channel = env.frameFrom(keys.id)
    expect(channel.handshake(hello(keys, {}, new Uint8Array(32).fill(9)))).toBe('unknown-device')
    expect(channel.handshake(hello(keys))).toBe('ok')
    expect(env.service.getState().devices[0]).toMatchObject({ online: true, lastSeen: env.timers.now() })
    const stranger = phoneKeys(8)
    expect(env.frameFrom(stranger.id).handshake(hello(stranger))).toBe('unknown-device')
  })

  it('revoke tells a connected phone, removes the pairing and tells the relay', () => {
    const env = pairedSetup()
    env.service.revoke(env.keys.id)
    expect(env.channel.sent.at(-1)).toEqual({ t: 'evt', e: 'pairing', status: 'revoked' })
    expect(env.channel.closed).toBe(true)
    expect(env.pairings.items).toEqual([])
    expect(env.transport().sent.at(-1)).toEqual({ t: 'revoke', phone: env.keys.id })
  })

  it('a revoke made while offline is kept and reaches the relay once it is back', () => {
    const env = pairedSetup()
    env.transport().setState({ kind: 'offline' })
    env.service.revoke(env.keys.id)
    expect(env.transport().sent.some(m => m.t === 'revoke')).toBe(false)
    expect(env.pairings.pendingRevokes()).toEqual([env.keys.id])
    env.transport().setState({ kind: 'online' })
    expect(env.transport().sent.at(-1)).toEqual({ t: 'revoke', phone: env.keys.id })
    expect(env.pairings.pendingRevokes()).toEqual([])
  })

  it('re-pairing a revoked phone cancels its pending revoke', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    const keys = phoneKeys(12)
    env.pairings.setPendingRevoke(keys.id, true)
    env.transport().setState({ kind: 'online' })
    expect(env.transport().sent).toEqual([{ t: 'revoke', phone: keys.id }])
    env.pairings.setPendingRevoke(keys.id, true)
    await env.service.startPairing()
    env.frameFrom(keys.id).handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))
    env.service.accept(keys.id)
    expect(env.pairings.pendingRevokes()).toEqual([])
  })

  it('tracks presence and last seen from peer messages', () => {
    const env = pairedSetup()
    env.transport().deliver({ t: 'peer', id: env.keys.id, state: 'offline', lastSeen: 5_000_000 })
    expect(env.channel.closed).toBe(true)
    expect(env.service.getState().devices[0]).toMatchObject({ online: false, lastSeen: 5_000_000 })
    env.transport().deliver({ t: 'peer', id: env.keys.id, state: 'online' })
    expect(env.service.getState().devices[0].online).toBe(true)
  })

  it('a pending request survives the phone going away until the pairing window lapses', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    await env.service.startPairing()
    const keys = phoneKeys(10)
    env.frameFrom(keys.id).handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))
    env.transport().deliver({ t: 'error', code: 'offline', to: keys.id })
    expect(env.service.getState().pending).toMatchObject({ phoneId: keys.id, online: false })
    env.timers.advance(301_000)
    expect(env.service.getState().pending).toBeNull()
  })

  it('a pending phone that reconnects re-handshakes with the same proof and stays pending', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    await env.service.startPairing()
    const keys = phoneKeys(13)
    expect(env.frameFrom(keys.id).handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))).toBe('pending')
    env.transport().deliver({ t: 'peer', id: keys.id, state: 'offline', lastSeen: env.timers.now() })
    expect(env.service.getState().invite).toBeNull()

    // Same phone, same proof, fresh channel: pending again, not rejected.
    env.transport().deliver({ t: 'peer', id: keys.id, state: 'online' })
    const again = env.frameFrom(keys.id)
    expect(again.handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))).toBe('pending')
    expect(env.service.getState().pending).toMatchObject({ phoneId: keys.id, online: true })
    // Another key presenting that proof is not let in.
    const other = phoneKeys(14)
    expect(env.frameFrom(other.id).handshake(hello(other, { kind: 'pair', proof: PROOF_B64 }))).toBe('rejected')
    const same = env.frameFrom(keys.id)
    expect(same.handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }, new Uint8Array(32).fill(3)))).toBe('rejected')
    expect(same.handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))).toBe('pending')

    env.service.accept(keys.id)
    expect(same.sent.at(-2)).toEqual({ t: 'evt', e: 'pairing', status: 'accepted' })
  })

  it('the relay socket dropping keeps the pending request', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    await env.service.startPairing()
    const keys = phoneKeys(15)
    env.frameFrom(keys.id).handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))
    env.transport().setState({ kind: 'offline', error: 'lost' })
    expect(env.service.getState().pending).toMatchObject({ phoneId: keys.id, online: false })
    env.transport().setState({ kind: 'online' })
    expect(env.frameFrom(keys.id).handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))).toBe('pending')
  })

  it('accepting a phone that is away lets its next pair handshake straight in', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    await env.service.startPairing()
    const keys = phoneKeys(16)
    env.frameFrom(keys.id).handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))
    env.transport().deliver({ t: 'error', code: 'offline', to: keys.id })
    env.service.accept(keys.id)
    expect(env.transport().sent.at(-1)).toEqual({ t: 'authorize', phone: keys.id, pub: keys.ed })
    const back = env.frameFrom(keys.id)
    expect(back.handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))).toBe('ok')
    // Only once: after that the phone resumes like any paired one.
    expect(back.handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))).toBe('rejected')
    expect(back.handshake(hello(keys))).toBe('ok')
  })

  it('losing the relay drops every session and all presence', () => {
    const env = pairedSetup()
    env.transport().setState({ kind: 'offline', error: 'lost' })
    expect(env.channel.closed).toBe(true)
    expect(env.service.getState().devices[0].online).toBe(false)
  })
})

describe('MobileService app messages', () => {
  it('answers inbox.get with the filtered inbox and unknown ops with unsupported', () => {
    const env = pairedSetup()
    env.channel.hooks.onAppMessage({ t: 'req', id: 4, op: 'inbox.get' })
    const res = env.channel.sent.at(-1) as Extract<DesktopAppMessage, { t: 'res'; ok: true }>
    expect(res).toMatchObject({ t: 'res', id: 4, ok: true })
    const inbox = res.result as { desktop: unknown; projects: { tasks: { id: string }[] }[] }
    expect(inbox.desktop).toEqual({ id: 'd'.repeat(32), name: 'host' })
    expect(inbox.projects[0].tasks.map(t => t.id)).toEqual(['t1'])

    env.channel.hooks.onAppMessage({ t: 'req', id: 5, op: 'chat.send' })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 5, ok: false, error: { code: 'unsupported' } })
    const count = env.channel.sent.length
    env.channel.hooks.onAppMessage({ t: 'evt', e: 'pairing', status: 'accepted' }) // not a request
    expect(env.channel.sent.length).toBe(count)
  })
})

describe('MobileService chat.settings (SPEC.md §8.5)', () => {
  it('hands parsed params to the bridge and rejects bad ones', () => {
    const requests: { op: string; params: unknown }[] = []
    const env = pairedSetup({
      chat: { request: (_phone, _id, op, params) => { requests.push({ op, params }) }, dropPhone: () => {}, dropAll: () => {}, projectsChanged: () => {} }
    })
    env.channel.hooks.onAppMessage({ t: 'req', id: 6, op: 'chat.settings', params: { tabId: 't', model: '', mode: null, extra: 1 } })
    expect(requests).toEqual([{ op: 'chat.settings', params: { tabId: 't', model: '' } }])
    env.channel.hooks.onAppMessage({ t: 'req', id: 7, op: 'chat.settings', params: { tabId: 't', mode: 'yolo' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 7, ok: false, error: { code: 'bad-request' } })
    expect(requests).toHaveLength(1)
  })
})

describe('MobileService chat.image (SPEC.md §8.9)', () => {
  it('hands parsed params to the bridge, clamping maxSide, and rejects bad ones', () => {
    const requests: { op: string; params: unknown }[] = []
    const env = pairedSetup({
      chat: { request: (_phone, _id, op, params) => { requests.push({ op, params }) }, dropPhone: () => {}, dropAll: () => {}, projectsChanged: () => {} }
    })
    env.channel.hooks.onAppMessage({ t: 'req', id: 6, op: 'chat.image', params: { tabId: 't', itemId: 'i', index: 1, maxSide: 9000 } })
    expect(requests).toEqual([{ op: 'chat.image', params: { tabId: 't', itemId: 'i', index: 1, maxSide: 4096 } }])
    env.channel.hooks.onAppMessage({ t: 'req', id: 7, op: 'chat.image', params: { tabId: 't', itemId: 'i' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 7, ok: false, error: { code: 'bad-request' } })
    expect(requests).toHaveLength(1)
  })
})

describe('MobileService chat.new (SPEC.md §8.2)', () => {
  it('answers with the new tab, passes errors through, and rejects a missing taskId', () => {
    const calls: string[] = []
    const env = pairedSetup({
      newChat: (taskId) => {
        calls.push(taskId)
        return taskId === 't1' ? { ok: true, tabId: 'tab-new' } : { ok: false, code: 'not-found', message: 'No such task' }
      }
    })
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'chat.new', params: { taskId: 't1' } })
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 1, ok: true, result: { tabId: 'tab-new' } })
    env.channel.hooks.onAppMessage({ t: 'req', id: 2, op: 'chat.new', params: { taskId: 'nope' } })
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 2, ok: false, error: { code: 'not-found', message: 'No such task' } })
    env.channel.hooks.onAppMessage({ t: 'req', id: 3, op: 'chat.new', params: {} })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 3, ok: false, error: { code: 'bad-request' } })
    expect(calls).toEqual(['t1', 'nope'])
  })

  it('is unsupported without the dependency', () => {
    const env = pairedSetup()
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'chat.new', params: { taskId: 't1' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 1, ok: false, error: { code: 'unsupported' } })
  })
})

describe('MobileService task.new (SPEC.md §8.4)', () => {
  it('answers with the new task and tab, passes errors through, and rejects bad params', async () => {
    const calls: unknown[] = []
    const env = pairedSetup({
      newTask: async (phoneId, params) => {
        calls.push({ phoneId, ...params })
        return params.projectId === 'p1'
          ? { ok: true, taskId: 'task-new', tabId: 'tab-new' }
          : { ok: false, code: 'not-found', message: 'No such project' }
      }
    })
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'task.new', params: { projectId: 'p1', prompt: 'Fix it', mode: 'plan' } })
    await Promise.resolve(); await Promise.resolve()
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 1, ok: true, result: { taskId: 'task-new', tabId: 'tab-new' } })
    env.channel.hooks.onAppMessage({ t: 'req', id: 2, op: 'task.new', params: { projectId: 'nope', prompt: 'Fix it' } })
    await Promise.resolve(); await Promise.resolve()
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 2, ok: false, error: { code: 'not-found', message: 'No such project' } })
    env.channel.hooks.onAppMessage({ t: 'req', id: 3, op: 'task.new', params: { projectId: 'p1', prompt: '  ' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 3, ok: false, error: { code: 'bad-request' } })
    expect(calls).toEqual([
      { phoneId: env.keys.id, projectId: 'p1', prompt: 'Fix it', mode: 'plan' },
      { phoneId: env.keys.id, projectId: 'nope', prompt: 'Fix it' }
    ])
  })

  it('answers internal when the desktop side throws', async () => {
    const env = pairedSetup({ newTask: async () => { throw new Error('boom') } })
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'task.new', params: { projectId: 'p1', prompt: 'Go' } })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 1, ok: false, error: { code: 'internal', message: 'boom' } })
  })

  it('is unsupported without the dependency', () => {
    const env = pairedSetup()
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'task.new', params: { projectId: 'p1', prompt: 'Go' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 1, ok: false, error: { code: 'unsupported' } })
  })
})

describe('MobileService task.close and tab.close (SPEC.md §8.7, §8.8)', () => {
  it('passes the flags through and answers with the result', async () => {
    const calls: unknown[] = []
    const env = pairedSetup({
      closeTask: async (params) => {
        calls.push(params)
        return params.discardWorkspace
          ? { ok: true, result: { closed: true } }
          : { ok: true, result: { closed: false, blocker: 'unmerged', branch: 'fix', baseBranch: 'main' } }
      }
    })
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'task.close', params: { taskId: 't1' } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 1, ok: true, result: { closed: false, blocker: 'unmerged', branch: 'fix', baseBranch: 'main' } })
    env.channel.hooks.onAppMessage({ t: 'req', id: 2, op: 'task.close', params: { taskId: 't1', discardWorkspace: true, keepBranch: true } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 2, ok: true, result: { closed: true } })
    env.channel.hooks.onAppMessage({ t: 'req', id: 3, op: 'task.close', params: {} })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 3, ok: false, error: { code: 'bad-request' } })
    expect(calls).toEqual([{ taskId: 't1' }, { taskId: 't1', discardWorkspace: true, keepBranch: true }])
  })

  it('closes a tab, passing errors through', async () => {
    const env = pairedSetup({
      closeTab: async (tabId) => tabId === 'tab1' ? { ok: true } : { ok: false, code: 'not-found', message: 'No such tab' }
    })
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'tab.close', params: { tabId: 'tab1' } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 1, ok: true, result: {} })
    env.channel.hooks.onAppMessage({ t: 'req', id: 2, op: 'tab.close', params: { tabId: 'nope' } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 2, ok: false, error: { code: 'not-found', message: 'No such tab' } })
  })

  it('is unsupported without the dependencies', () => {
    const env = pairedSetup()
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'task.close', params: { taskId: 't1' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 1, ok: false, error: { code: 'unsupported' } })
    env.channel.hooks.onAppMessage({ t: 'req', id: 2, op: 'tab.close', params: { tabId: 'tab1' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 2, ok: false, error: { code: 'unsupported' } })
  })
})

describe('MobileService pin.set (SPEC.md §8.10)', () => {
  it('passes the params through and answers {}', () => {
    const calls: unknown[] = []
    const env = pairedSetup({
      setPin: (params) => {
        calls.push(params)
        return params.projectId === 'p1' ? { ok: true } : { ok: false, code: 'not-found', message: 'No such project' }
      }
    })
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'pin.set', params: { projectId: 'p1', taskId: 't1', pinned: true } })
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 1, ok: true, result: {} })
    env.channel.hooks.onAppMessage({ t: 'req', id: 2, op: 'pin.set', params: { projectId: 'nope', pinned: false } })
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 2, ok: false, error: { code: 'not-found', message: 'No such project' } })
    env.channel.hooks.onAppMessage({ t: 'req', id: 3, op: 'pin.set', params: { projectId: 'p1' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 3, ok: false, error: { code: 'bad-request' } })
    expect(calls).toEqual([{ projectId: 'p1', taskId: 't1', pinned: true }, { projectId: 'nope', pinned: false }])
  })

  it('is unsupported without the dependency', () => {
    const env = pairedSetup()
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'pin.set', params: { projectId: 'p1', pinned: true } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 1, ok: false, error: { code: 'unsupported' } })
  })
})

describe('MobileService task.triage (SPEC.md §8.11)', () => {
  it('passes the params through and answers {}', () => {
    const calls: unknown[] = []
    const env = pairedSetup({
      triageTask: (params) => {
        calls.push(params)
        return params.taskId === 't1' ? { ok: true } : { ok: false, code: 'not-found', message: 'No such task' }
      }
    })
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'task.triage', params: { taskId: 't1', action: 'snooze', untilAttention: true } })
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 1, ok: true, result: {} })
    env.channel.hooks.onAppMessage({ t: 'req', id: 2, op: 'task.triage', params: { taskId: 'nope', action: 'read' } })
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 2, ok: false, error: { code: 'not-found', message: 'No such task' } })
    env.channel.hooks.onAppMessage({ t: 'req', id: 3, op: 'task.triage', params: { taskId: 't1', action: 'snooze' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 3, ok: false, error: { code: 'bad-request' } })
    expect(calls).toEqual([{ taskId: 't1', action: 'snooze', untilAttention: true }, { taskId: 'nope', action: 'read' }])
  })

  it('is unsupported without the dependency', () => {
    const env = pairedSetup()
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'task.triage', params: { taskId: 't1', action: 'read' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 1, ok: false, error: { code: 'unsupported' } })
  })
})

describe('MobileService inbox events', () => {
  it('sends a change on the next tick, then at most once per second with the latest state', () => {
    const env = pairedSetup()
    env.setStatus('tab1', 'working')
    expect(env.channel.inboxEvents()).toHaveLength(0) // coalesced to the next tick
    env.timers.advance(0)
    expect(env.channel.inboxEvents().map(e => e.seq)).toEqual([1])

    env.timers.advance(100)
    env.setStatus('tab1', 'attention')
    env.timers.advance(100)
    env.setStatus('tab1', 'exited')
    env.timers.advance(700)
    expect(env.channel.inboxEvents()).toHaveLength(1) // still inside the window
    env.timers.advance(100)
    const events = env.channel.inboxEvents()
    expect(events.map(e => e.seq)).toEqual([1, 2])
    expect(events[1].inbox.projects[0].tasks[0].tabs[0].status).toBe('exited')
  })

  it('never sends two events less than a second apart under a steady stream', () => {
    const env = pairedSetup()
    const sentAt: number[] = []
    let seen = 0
    for (let i = 0; i < 50; i++) {
      env.setStatus('tab1', i % 2 ? 'working' : 'attention')
      env.timers.advance(97)
      const n = env.channel.inboxEvents().length
      if (n > seen) { sentAt.push(env.timers.now()); seen = n }
    }
    env.timers.advance(2000)
    for (let i = 1; i < sentAt.length; i++) expect(sentAt[i] - sentAt[i - 1]).toBeGreaterThanOrEqual(INBOX_THROTTLE_MS - 100)
    const seqs = env.channel.inboxEvents().map(e => e.seq)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))
  })

  it('skips changes the phone cannot see', () => {
    const env = pairedSetup()
    env.setStatus('tab1', 'working')
    env.timers.advance(0)
    env.timers.advance(2000)
    env.setStatus('tab1', 'working') // same inbox content
    env.timers.advance(2000)
    env.setStatus('other-tab', 'working') // not in any task
    env.timers.advance(2000)
    expect(env.channel.inboxEvents()).toHaveLength(1)
  })

  it('reacts to project changes too, and respects hideFromMobile', () => {
    const env = pairedSetup()
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'inbox.get' })
    const projects = (env.service as unknown as { deps: MobileServiceDeps }).deps.projects.peek()
    env.setProjects({ ...projects, projects: projects.projects.map(p => ({ ...p, hideFromMobile: true as const })) })
    env.timers.advance(0)
    expect(env.channel.inboxEvents().at(-1)?.inbox.projects).toEqual([])
  })

  it('does nothing without a paired session, and not for pending phones', async () => {
    const env = setup({ enabled: true })
    env.service.start()
    env.transport().setState({ kind: 'online' })
    env.setStatus('tab1', 'working')
    expect(env.timers.pending).toBe(0)
    await env.service.startPairing()
    const keys = phoneKeys(11)
    const channel = env.frameFrom(keys.id)
    channel.handshake(hello(keys, { kind: 'pair', proof: PROOF_B64 }))
    env.timers.advance(0)
    env.setStatus('tab1', 'attention')
    env.timers.advance(2000)
    expect(channel.inboxEvents()).toHaveLength(0)
  })

  it('restarts seq with each new handshake', () => {
    const env = pairedSetup()
    env.setStatus('tab1', 'working')
    env.timers.advance(0)
    expect(env.channel.inboxEvents().at(-1)?.seq).toBe(1)
    env.channel.handshake(hello(env.keys))
    env.timers.advance(2000)
    env.setStatus('tab1', 'attention')
    env.timers.advance(0)
    expect(env.channel.inboxEvents().at(-1)?.seq).toBe(1)
  })
})

describe('MobileService push (SPEC.md §7)', () => {
  const REG = { cap: 'cap-1', key: b64u(new Uint8Array(32).fill(5)), keyId: b64u(new Uint8Array(8).fill(6)), kinds: ['permission', 'done'] }

  function registered() {
    const env = pairedSetup()
    env.channel.hooks.onAppMessage({ t: 'req', id: 1, op: 'push.register', params: { ...REG, kinds: [...REG.kinds, 'later'] } })
    return env
  }

  it('stores and clears a registration with push.register / push.unregister', () => {
    const env = registered()
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 1, ok: true, result: {} })
    expect(env.pairings.get(env.keys.id)?.push).toEqual(REG)
    expect(env.service.pushTargets()).toEqual([{ phoneId: env.keys.id, push: REG }])
    env.channel.hooks.onAppMessage({ t: 'req', id: 2, op: 'push.unregister' })
    expect(env.channel.sent.at(-1)).toEqual({ t: 'res', id: 2, ok: true, result: {} })
    expect(env.pairings.get(env.keys.id)?.push).toBeUndefined()
    expect(env.service.pushTargets()).toEqual([])
  })

  it('answers bad-request for malformed params', () => {
    const env = pairedSetup()
    env.channel.hooks.onAppMessage({ t: 'req', id: 3, op: 'push.register', params: { ...REG, key: 'short' } })
    expect(env.channel.sent.at(-1)).toMatchObject({ t: 'res', id: 3, ok: false, error: { code: 'bad-request' } })
    expect(env.pairings.get(env.keys.id)?.push).toBeUndefined()
  })

  it('sends push over the relay and resolves with the relay result', async () => {
    const env = registered()
    const outcome = env.service.sendPush(env.keys.id, 'DATA')
    const sent = env.transport().sent.at(-1)
    expect(sent).toEqual({ t: 'push', id: 0, cap: 'cap-1', data: 'DATA' })
    env.transport().deliver({ t: 'pushed', id: 0, result: 'ok' })
    await expect(outcome).resolves.toBe('ok')
    expect(env.pairings.get(env.keys.id)?.push).toEqual(REG)
  })

  it('drops the registration on gone', async () => {
    const env = registered()
    const outcome = env.service.sendPush(env.keys.id, 'DATA')
    env.transport().deliver({ t: 'pushed', id: 0, result: 'gone' })
    await expect(outcome).resolves.toBe('gone')
    expect(env.pairings.get(env.keys.id)?.push).toBeUndefined()
  })

  it('is not-sent without a registration or a socket, and error when the socket drops or the relay is silent', async () => {
    const env = registered()
    await expect(env.service.sendPush('f'.repeat(32), 'DATA')).resolves.toBe('not-sent')
    const dropped = env.service.sendPush(env.keys.id, 'DATA')
    env.transport().setState({ kind: 'offline' })
    await expect(dropped).resolves.toBe('error')
    await expect(env.service.sendPush(env.keys.id, 'DATA')).resolves.toBe('not-sent')
    env.transport().setState({ kind: 'online' })
    const silent = env.service.sendPush(env.keys.id, 'DATA')
    env.timers.advance(20_000)
    await expect(silent).resolves.toBe('error')
    // A late answer for a settled push is ignored.
    env.transport().deliver({ t: 'pushed', id: 1, result: 'gone' })
    expect(env.pairings.get(env.keys.id)?.push).toEqual(REG)
  })
})

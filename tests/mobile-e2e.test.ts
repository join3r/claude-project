import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MobileService } from '../src/main/mobile/mobile-service'
import { IdentityStore, type SecretEncryptor } from '../src/main/mobile/identity'
import { PairingsStore } from '../src/main/mobile/pairings-store'
import { RelayClient } from '../src/main/mobile/relay-client'
import { createNoiseChannelFactory } from '../src/main/mobile/channel'
import { createInvite } from '../src/main/mobile/invite'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'
import { DEFAULT_MOBILE_CONFIG, type MobileConfig, type MobileState } from '../src/shared/mobile'
import type { ProjectsData } from '../src/shared/types'
import type { AppMessage, InboxEvent } from '../protocol/ts/index.ts'
import { startRelayServer, type RelayServer } from '../relay/src/server.ts'
import { MemoryStore } from '../relay/src/store.ts'
import { RelayPhone, waitFor } from './helpers/relay-phone'
import { ChatBridge } from '../src/main/mobile/chat-bridge'
import { FakeChats } from './helpers/fake-chats'
import { fixtureProject } from './helpers/streams-fixtures'
import type { ChatViewEvent } from '../protocol/ts/index.ts'

/**
 * The desktop's real mobile stack — MobileService, identity, pairings, RelayClient
 * over the runtime's global WebSocket, the Noise channel — against a relay on a real
 * port, with a phone built only from protocol/ts on the other end.
 *
 * The relay is the real one from `relay/src` (in process, ephemeral port, memory store),
 * so this also checks the desktop against the relay's actual behaviour (protocol/SPEC.md §3.7).
 */

const encryptor: SecretEncryptor = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(text).reverse(),
  decrypt: (buf) => Buffer.from(buf).reverse().toString()
}

const PROJECTS: ProjectsData = {
  projects: [
    fixtureProject({
      id: 'p1', name: 'api-server', emoji: '🚀', directory: '/src/api',
      tasks: [{
        id: 't1', name: 'fix-auth',
        tabs: { left: [{ id: 'tab-chat', type: 'claude-chat', title: 'Claude', sessionId: 'sess-e2e' }, { id: 'tab-web', type: 'browser', title: 'Docs' }] },
        activeTab: { left: 'tab-chat' }
      }]
    }),
    fixtureProject({ id: 'p2', name: 'secret', directory: '/src/secret', hideFromMobile: true, tasks: [] })
  ],
  tags: [],
  projectOrder: ['p1', 'p2'],
  pinnedItems: []
}

function inboxEvents(messages: AppMessage[]): InboxEvent[] {
  return messages.filter((m): m is InboxEvent => m.t === 'evt' && m.e === 'inbox')
}

describe('mobile end to end (real relay)', () => {
  let dir: string
  let store: MemoryStore
  let relay: RelayServer
  let service: MobileService
  let registry: TabActivityRegistry
  let states: MobileState[]
  let config: MobileConfig
  let chats: FakeChats
  const phones: RelayPhone[] = []

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-mobile-e2e-'))
    store = new MemoryStore()
    relay = await startRelayServer({ store, port: 0, host: '127.0.0.1' })
    registry = new TabActivityRegistry()
    states = []
    config = { ...DEFAULT_MOBILE_CONFIG, relayUrl: relay.url }
    const identity = new IdentityStore(dir, encryptor)
    const listeners = new Set<() => void>()
    chats = new FakeChats()
    service = new MobileService({
      getConfig: () => config,
      saveConfig: (next) => { config = next },
      projects: { peek: () => PROJECTS, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) } },
      activity: registry,
      pairings: new PairingsStore(dir),
      getDesktopId: () => identity.peekId(),
      defaultDesktopName: () => 'e2e-desktop',
      createTransport: () => new RelayClient({ ed25519: () => identity.get().ed25519, deviceId: () => identity.get().id }),
      channels: createNoiseChannelFactory({
        staticKey: () => identity.get().x25519,
        app: 'devtool/test',
        desktopName: () => 'e2e-desktop',
        log: () => {}
      }),
      createInvite: (options) => createInvite(identity.get(), options),
      broadcastState: (state) => states.push(state),
      log: () => {},
      chat: new ChatBridge({
        chats,
        projects: { peek: () => PROJECTS },
        timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
        log: () => {}
      })
    })
    service.start()
  })

  afterEach(async () => {
    service.stop()
    for (const phone of phones.splice(0)) phone.close()
    await relay.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('pairs, serves the inbox, pushes a status change, resumes, and revokes', { timeout: 20_000 }, async () => {
    // Pairing turns Mobile on and connects.
    const invite = await service.startPairing()
    expect(config.enabled).toBe(true)
    await waitFor(() => service.getState().connection.kind === 'online', 'desktop online')

    // A phone scans the code: connects as pending, sends message 1 with the proof.
    const phone = new RelayPhone(invite.uri)
    phones.push(phone)
    await waitFor(() => service.getState().invite !== null, 'offer live')
    // The offer reaches the relay right after ready; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await phone.connect('pair')
    phone.phone.startHandshake(phone.phone.hello('pair', phone.secret))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello !== null, 'message 2')
    expect(phone.phone.desktopHello).toMatchObject({ result: 'pending', desktopName: 'e2e-desktop', app: 'devtool/test' })
    await waitFor(() => service.getState().pending !== null, 'pending request')
    expect(service.getState().pending).toMatchObject({ phoneId: phone.phone.id, name: 'Test iPhone' })
    expect(service.getState().invite).toBeNull()

    // The phone's socket blips before Accept. The relay keeps it pending (§3.7), the
    // desktop keeps the request, and the phone's pair handshake is answered `pending` again.
    phone.close()
    await waitFor(() => service.getState().pending?.online === false, 'pending phone offline')
    await phone.connect('pair')
    phone.phone.startHandshake(phone.phone.hello('pair', phone.secret))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello !== null, 'message 2 after reconnect')
    expect(phone.phone.desktopHello?.result).toBe('pending')
    await waitFor(() => service.getState().pending?.online === true, 'pending phone back')
    expect(phone.relayMessages.filter(m => m.t === 'error')).toEqual([])

    // Before Accept the phone gets nothing.
    phone.phone.request(1, 'inbox.get')
    phone.flush()
    await waitFor(() => phone.phone.messages.length === 1, 'not-authorized answer')
    expect(phone.phone.messages[0]).toMatchObject({ t: 'res', id: 1, ok: false, error: { code: 'not-authorized' } })

    // Accept: stored, authorized at the relay, the phone hears about it and gets an inbox.
    service.accept(phone.phone.id)
    await waitFor(() => inboxEvents(phone.phone.messages).length === 1, 'first inbox event')
    expect(phone.phone.messages[1]).toEqual({ t: 'evt', e: 'pairing', status: 'accepted' })
    const first = inboxEvents(phone.phone.messages)[0]
    expect(first.seq).toBe(1)
    expect(first.inbox.desktop).toEqual({ id: phone.desktopId, name: 'e2e-desktop' })
    expect(first.inbox.projects.map(p => p.id)).toEqual(['p1'])
    expect(first.inbox.projects[0].tasks.map(t => t.id)).toEqual(['t1'])
    expect(first.inbox.projects[0].tasks[0].tabs).toEqual([{ id: 'tab-chat', type: 'claude-chat', title: 'Claude', status: 'idle' }])
    await waitFor(() => store.getPair(phone.desktopId, phone.phone.id) !== null, 'relay authorize')
    expect(service.getState().devices).toMatchObject([{ id: phone.phone.id, name: 'Test iPhone', online: true }])

    // inbox.get answers with the same picture.
    phone.phone.request(2, 'inbox.get')
    phone.phone.request(3, 'tasks.create')
    phone.flush()
    await waitFor(() => phone.phone.messages.some(m => m.t === 'res' && m.id === 3), 'responses')
    const res = phone.phone.messages.find(m => m.t === 'res' && m.id === 2)
    expect(res).toMatchObject({ ok: true, result: { projects: [{ id: 'p1' }] } })
    expect(phone.phone.messages.find(m => m.t === 'res' && m.id === 3)).toMatchObject({ ok: false, error: { code: 'unsupported' } })

    // A hook moves the tab to working: a new inbox event follows (throttled, ≤ 1/s).
    registry.working('tab-chat')
    registry.applyHook('tab-chat', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } })
    await waitFor(() => inboxEvents(phone.phone.messages).some(e => e.inbox.projects[0].tasks[0].tabs[0].status === 'working'
      && e.inbox.projects[0].tasks[0].tabs[0].activity === 'Bash · npm test'), 'working inbox event', 4000)
    const seqs = inboxEvents(phone.phone.messages).map(e => e.seq)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))

    // The phone reconnects and resumes with its stored keys.
    phone.close()
    await waitFor(() => service.getState().devices[0]?.online === false, 'phone offline')
    const before = phone.phone.messages.length
    await phone.connect('resume')
    phone.phone.startHandshake(phone.phone.hello('resume'))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello?.result === 'ok', 'resume ok')
    await waitFor(() => service.getState().devices[0]?.online === true, 'phone online again')
    phone.phone.request(4, 'inbox.get')
    phone.flush()
    await waitFor(() => phone.phone.messages.length > before, 'resumed inbox')
    expect(phone.phone.messages.at(-1)).toMatchObject({ t: 'res', id: 4, ok: true })

    // Revoke: the phone is told over the channel and by the relay.
    service.revoke(phone.phone.id)
    await waitFor(() => phone.relayMessages.some(m => m.t === 'peer' && m.state === 'revoked'), 'peer revoked')
    expect(phone.phone.messages.at(-1)).toEqual({ t: 'evt', e: 'pairing', status: 'revoked' })
    expect(store.phonesForDesktop(phone.desktopId)).toEqual([])
    expect(service.getState().devices).toEqual([])
  })

  it('drives a chat: open, stream, send, answer, gone, interrupt, and a transcript over 60 KB', { timeout: 20_000 }, async () => {
    const invite = await service.startPairing()
    await waitFor(() => service.getState().connection.kind === 'online', 'desktop online')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const phone = new RelayPhone(invite.uri)
    phones.push(phone)
    await phone.connect('pair')
    phone.phone.startHandshake(phone.phone.hello('pair', phone.secret))
    phone.flush()
    await waitFor(() => service.getState().pending !== null, 'pending request')
    service.accept(phone.phone.id)
    await waitFor(() => inboxEvents(phone.phone.messages).length === 1, 'inbox')

    const res = (id: number) => phone.phone.messages.find(m => m.t === 'res' && m.id === id)
    const chatEvents = () => phone.phone.messages.filter((m): m is ChatViewEvent => m.t === 'evt' && m.e === 'chat')
    const call = async (id: number, op: string, params: unknown) => {
      phone.phone.request(id, op, params)
      phone.flush()
      await waitFor(() => res(id) !== undefined, `${op} result`)
      return res(id)
    }

    // 70 items of ~1 KB each: the open's 60-item window is ~60 KB+, so it arrives in fragments.
    const filler = 'lorem ipsum '.repeat(90)
    chats.update('tab-chat', (s) => ({ ...s, items: Array.from({ length: 70 }, (_, i) => ({ kind: 'text' as const, id: `h${i}`, text: `${i} ${filler}` })) }))
    const framesBefore = phone.phone.transportFrames
    const open = await call(10, 'chat.open', { tabId: 'tab-chat' })
    expect(open).toMatchObject({ ok: true, result: { seq: 0, view: { tabId: 'tab-chat', title: 'Claude', hasEarlier: true } } })
    const view = (open as { result: { view: { items: { id: string }[] } } }).result.view
    expect(view.items).toHaveLength(60)
    expect(view.items[0].id).toBe('h10')
    expect(phone.phone.transportFrames - framesBefore).toBeGreaterThan(1)

    // Unknown tabs answer not-found.
    expect(await call(11, 'chat.open', { tabId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
    await call(12, 'chat.open', { tabId: 'tab-chat' })

    // Send from the phone: the user item and busy come back as an event.
    expect(await call(13, 'chat.send', { tabId: 'tab-chat', text: 'say hi' })).toMatchObject({ ok: true, result: {} })
    expect(chats.sent).toEqual([{ tabId: 'tab-chat', text: 'say hi' }])
    await waitFor(() => chatEvents().some(e => e.busy && e.upserts.some(i => i.kind === 'user' && i.text === 'say hi')), 'user item event')

    // A streaming reply, then a permission prompt.
    for (const partial of ['Hi', 'Hi the', 'Hi there']) {
      chats.update('tab-chat', (s) => ({ ...s, items: [...s.items.filter(i => i.id !== 'r1'), { kind: 'text', id: 'r1', text: partial, streaming: true }] }))
    }
    chats.update('tab-chat', (s) => ({ ...s, pending: [{ id: 'perm-1', kind: 'permission', toolName: 'Bash', input: { command: 'ls' } }] }))
    await waitFor(() => chatEvents().some(e => e.prompts.some(p => p.id === 'perm-1')), 'prompt event')
    const withPrompt = chatEvents().find(e => e.prompts.some(p => p.id === 'perm-1'))
    expect(withPrompt?.upserts).toContainEqual({ kind: 'text', id: 'r1', markdown: 'Hi there', streaming: true })

    expect(await call(14, 'chat.answer', { tabId: 'tab-chat', promptId: 'perm-1', answer: { behavior: 'allow' } })).toMatchObject({ ok: true })
    expect(chats.responses).toEqual([{ tabId: 'tab-chat', promptId: 'perm-1', response: { behavior: 'allow' } }])
    await waitFor(() => chatEvents().at(-1)?.prompts.length === 0, 'prompt cleared')
    expect(await call(15, 'chat.answer', { tabId: 'tab-chat', promptId: 'perm-1', answer: { behavior: 'allow' } })).toMatchObject({ ok: false, error: { code: 'gone' } })
    expect(await call(16, 'chat.answer', { tabId: 'tab-chat', promptId: 'perm-1', answer: { behavior: 'nope' } })).toMatchObject({ ok: false, error: { code: 'bad-request' } })

    expect(await call(17, 'chat.interrupt', { tabId: 'tab-chat' })).toMatchObject({ ok: true })
    expect(chats.interrupts).toEqual(['tab-chat'])

    // Event seqs run 1, 2, 3… after the second open's seq.
    const seqs = chatEvents().map(e => e.seq)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))

    // A reconnect drops the subscription.
    phone.close()
    await waitFor(() => chats.listenerCount('tab-chat') === 0, 'subscription dropped')
  })

  it('a phone with the wrong proof is refused and the code stays usable', { timeout: 10_000 }, async () => {
    const invite = await service.startPairing()
    await waitFor(() => service.getState().connection.kind === 'online', 'desktop online')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const phone = new RelayPhone(invite.uri)
    phones.push(phone)
    await phone.connect('pair')
    phone.phone.startHandshake(phone.phone.hello('pair', new Uint8Array(32).fill(1)))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello !== null, 'message 2')
    expect(phone.phone.desktopHello?.result).toBe('rejected')
    expect(service.getState().pending).toBeNull()
    expect(service.getState().invite).not.toBeNull()
  })

  it('reconnects after the relay restarts, and re-sends the live offer', { timeout: 10_000 }, async () => {
    await service.startPairing()
    await waitFor(() => service.getState().connection.kind === 'online', 'desktop online')
    // Restart the relay on the same port: it closes every socket with 1001 and forgets offers.
    const port = relay.port
    await relay.close()
    await waitFor(() => service.getState().connection.kind !== 'online', 'desktop dropped')
    relay = await startRelayServer({ store, port, host: '127.0.0.1' })
    await waitFor(() => service.getState().connection.kind === 'online', 'desktop back', 5000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The re-sent offer is what lets a phone still attach with the same code.
    const phone = new RelayPhone(service.getState().invite!.uri)
    phones.push(phone)
    await phone.connect('pair')
    expect(phone.ready).toBe(true)
    // The real relay answers `ready` even to a stale token (§3.7), so prove the phone is
    // pending by completing the pair handshake through it.
    phone.phone.startHandshake(phone.phone.hello('pair', phone.secret))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello !== null, 'message 2')
    expect(phone.phone.desktopHello?.result).toBe('pending')
    expect(phone.relayMessages.filter(m => m.t === 'error')).toEqual([])
  })
})

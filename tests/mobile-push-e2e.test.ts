import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'
import { MobileService } from '../src/main/mobile/mobile-service'
import { IdentityStore, type SecretEncryptor } from '../src/main/mobile/identity'
import { PairingsStore } from '../src/main/mobile/pairings-store'
import { RelayClient } from '../src/main/mobile/relay-client'
import { createNoiseChannelFactory } from '../src/main/mobile/channel'
import { createInvite } from '../src/main/mobile/invite'
import { ChatBridge } from '../src/main/mobile/chat-bridge'
import { PushEmitter } from '../src/main/mobile/push-emitter'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'
import { DEFAULT_MOBILE_CONFIG, type MobileConfig } from '../src/shared/mobile'
import { createHomeTask, type ProjectsData } from '../src/shared/types'
import type { ChatPrompt } from '../src/shared/claude-chat'
import { b64uEncode, openPushPayload, signPushRegister, type PushPayload } from '../protocol/ts/index.ts'
import { startRelayServer, type RelayServer } from '../relay/src/server.ts'
import { MemoryStore } from '../relay/src/store.ts'
import { createPushGateway } from '../relay/src/push/gateway.ts'
import type { ApnsRequest, ApnsSender } from '../relay/src/push/apns.ts'
import { RelayPhone, waitFor } from './helpers/relay-phone'
import { FakeChats } from './helpers/fake-chats'
import { fixtureProject } from './helpers/streams-fixtures'

/**
 * Push end to end (SPEC.md §7): the phone registers with a real relay acting as the
 * gateway, hands the cap to the real desktop stack over the Noise channel, and a
 * prompt in a chat comes out at the (fake) APNs sender as a payload only the
 * phone's key opens.
 */

const encryptor: SecretEncryptor = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(text).reverse(),
  decrypt: (buf) => Buffer.from(buf).reverse().toString()
}

const PROJECTS: ProjectsData = {
  projects: [fixtureProject({
    id: 'p1', name: 'api-server', directory: '/src/api',
    tasks: [createHomeTask('p1').task, {
      id: 't1', name: 'fix-auth',
      tabs: { left: [{ id: 'tab-chat', type: 'claude-chat', title: 'Claude', sessionId: 'sess-e2e' }] },
      activeTab: { left: 'tab-chat' }
    }]
  })],
  tags: [],
  projectOrder: ['p1'],
  pinnedItems: []
}

const bash: ChatPrompt = { id: 'pr1', kind: 'permission', toolName: 'Bash', input: { command: 'npm test' } }

class CapturingSender implements ApnsSender {
  readonly mode = 'log' as const
  readonly requests: ApnsRequest[] = []
  status = 200
  reason: string | undefined
  send(request: ApnsRequest) {
    this.requests.push(request)
    return Promise.resolve(this.reason ? { status: this.status, reason: this.reason } : { status: this.status })
  }
  close() {}
}

describe('mobile push end to end (real relay as gateway)', () => {
  let dir: string
  let relay: RelayServer
  let service: MobileService
  let emitter: PushEmitter
  let chats: FakeChats
  let sender: CapturingSender
  let config: MobileConfig
  const phones: RelayPhone[] = []

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-push-e2e-'))
    const store = new MemoryStore()
    sender = new CapturingSender()
    const gateway = createPushGateway({ store, sealKey: new Uint8Array(randomBytes(32)), sender })
    relay = await startRelayServer({ store, port: 0, host: '127.0.0.1', gateway })
    config = { ...DEFAULT_MOBILE_CONFIG, relayUrl: relay.url }
    const identity = new IdentityStore(dir, encryptor)
    chats = new FakeChats()
    let bridge: ChatBridge | null = null
    let svc: MobileService | null = null
    emitter = new PushEmitter({
      chats,
      projects: { peek: () => PROJECTS },
      targets: () => svc?.pushTargets() ?? [],
      openTab: (phoneId) => bridge?.openTab(phoneId) ?? null,
      send: (phoneId, data) => svc?.sendPush(phoneId, data) ?? Promise.resolve('not-sent'),
      desktopId: () => identity.peekId(),
      now: () => Date.now(),
      log: () => {}
    })
    bridge = new ChatBridge({
      chats,
      projects: { peek: () => PROJECTS },
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
      log: () => {},
      onPhoneSend: (phoneId, tabId) => emitter.phoneSent(phoneId, tabId)
    })
    svc = new MobileService({
      getConfig: () => config,
      saveConfig: (next) => { config = next },
      projects: { peek: () => PROJECTS, subscribe: () => () => {} },
      activity: new TabActivityRegistry(),
      pairings: new PairingsStore(dir),
      getDesktopId: () => identity.peekId(),
      defaultDesktopName: () => 'e2e-desktop',
      createTransport: () => new RelayClient({ ed25519: () => identity.get().ed25519, deviceId: () => identity.get().id }),
      channels: createNoiseChannelFactory({ staticKey: () => identity.get().x25519, app: 'devtool/test', desktopName: () => 'e2e-desktop', log: () => {} }),
      createInvite: (options) => createInvite(identity.get(), options),
      broadcastState: () => {},
      log: () => {},
      chat: bridge
    })
    service = svc
    emitter.start()
    service.start()
  })

  afterEach(async () => {
    emitter.stop()
    service.stop()
    for (const phone of phones.splice(0)) phone.close()
    await relay.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('registers, pushes a prompt and a finished turn, skips an open chat, and drops a dead token', { timeout: 20_000 }, async () => {
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
    await waitFor(() => phone.phone.messages.some(m => m.t === 'evt' && m.e === 'inbox'), 'inbox')

    const res = (id: number) => phone.phone.messages.find(m => m.t === 'res' && m.id === id)
    const call = async (id: number, op: string, params?: unknown) => {
      phone.phone.request(id, op, params)
      phone.flush()
      await waitFor(() => res(id) !== undefined, `${op} result`)
      return res(id)
    }

    // §7.1: the phone registers its APNs token with the gateway over HTTP.
    const token = 'ab'.repeat(32)
    const body = signPushRegister(phone.phone.ed.priv, phone.phone.ed.pub, token, 'sandbox', Math.floor(Date.now() / 1000))
    const http = relay.url.replace(/^ws/, 'http')
    const registered = await fetch(`${http}/v1/push/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(registered.status).toBe(200)
    const { cap } = await registered.json() as { cap: string }

    // §7.4: and hands the cap plus its own payload key to the desktop.
    const key = new Uint8Array(randomBytes(32))
    const keyId = new Uint8Array(randomBytes(8))
    expect(await call(1, 'push.register', { cap, key: b64uEncode(key), keyId: b64uEncode(keyId), kinds: ['permission', 'question', 'done'] }))
      .toMatchObject({ ok: true })
    await waitFor(() => service.getState().devices[0]?.push === true, 'registration stored')

    const opened = (i: number): PushPayload | null => openPushPayload(key, sender.requests[i].data)

    // A permission prompt in a chat nobody has open: one push, only the phone can read it.
    chats.update('tab-chat', (s) => ({ ...s, busy: true, pending: [bash] }))
    await waitFor(() => sender.requests.length === 1, 'permission push')
    expect(sender.requests[0]).toMatchObject({ token, env: 'sandbox', device: phone.phone.id })
    expect(opened(0)).toMatchObject({ kind: 'permission', tab: 'tab-chat', prompt: 'pr1', title: 'api-server / fix-auth', body: 'Bash · npm test', desktop: phone.desktopId })

    // With the chat open on the phone, a new prompt is not pushed.
    expect(await call(2, 'chat.open', { tabId: 'tab-chat' })).toMatchObject({ ok: true })
    chats.update('tab-chat', (s) => ({ ...s, pending: [bash, { ...bash, id: 'pr2' }] }))
    expect(await call(3, 'chat.close', { tabId: 'tab-chat' })).toMatchObject({ ok: true })

    // A turn the phone started ends: "done", with the reply's first line.
    chats.update('tab-chat', (s) => ({ ...s, busy: false, pending: [] }))
    expect(await call(4, 'chat.send', { tabId: 'tab-chat', text: 'run it' })).toMatchObject({ ok: true })
    chats.update('tab-chat', (s) => ({ ...s, busy: false, items: [...s.items, { kind: 'text', id: 'a1', text: 'All green.' }] }))
    await waitFor(() => sender.requests.length === 2, 'done push')
    expect(opened(1)).toMatchObject({ kind: 'done', body: 'All green.' })
    expect(opened(1)?.prompt).toBeUndefined()

    // APNs says the token is dead: the desktop forgets the registration (§7.2 gone).
    sender.status = 410
    sender.reason = 'Unregistered'
    chats.update('tab-chat', (s) => ({ ...s, busy: true, pending: [{ ...bash, id: 'pr3' }] }))
    await waitFor(() => service.getState().devices[0]?.push === false, 'registration dropped')
    expect(sender.requests).toHaveLength(3)
  })
})

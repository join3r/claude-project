import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { b64uEncode, isServerApp, openPushPayload, signPushRegister, type AppMessage, type ChatViewEvent, type InboxEvent, type PushPayload } from '../protocol/ts/index.ts'
import { startRelayServer, type RelayServer } from '../relay/src/server.ts'
import { MemoryStore } from '../relay/src/store.ts'
import { createPushGateway } from '../relay/src/push/gateway.ts'
import type { ApnsRequest, ApnsSender } from '../relay/src/push/apns.ts'
import type { MobilePairingInvite, MobileState } from '../src/shared/mobile'
import type { ProjectsData } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'
import { RelayPhone, waitFor } from './helpers/relay-phone'
import { pairByCode, startTestDesktop, startTestServer, type TestDesktop, type TestServer } from './helpers/host-link'

/**
 * Phones on a DevTool server (plan step 10): a phone built from protocol/ts pairs
 * with the server's own MobileService through a real relay (in process, acting as
 * the push gateway too), next to the desktops on the server's one relay socket.
 * The server is the same code the daemon runs, with a fake `claude` for its chats.
 */

class CapturingSender implements ApnsSender {
  readonly mode = 'log' as const
  readonly requests: ApnsRequest[] = []
  send(request: ApnsRequest) {
    this.requests.push(request)
    return Promise.resolve({ status: 200 })
  }
  close() {}
}

const fakeClaude = path.resolve('tests/helpers/fake-claude.mjs')

function inboxEvents(messages: AppMessage[]): InboxEvent[] {
  return messages.filter((m): m is InboxEvent => m.t === 'evt' && m.e === 'inbox')
}

/** Every text an open chat has shown the phone so far (the open's view and its events). */
function chatTexts(messages: AppMessage[], tabId: string): string[] {
  const texts: string[] = []
  for (const m of messages) {
    if (m.t === 'res' && m.ok && (m.result as { view?: { tabId?: string; items?: { kind: string; markdown?: string }[] } })?.view?.tabId === tabId) {
      for (const item of (m.result as { view: { items: { kind: string; markdown?: string }[] } }).view.items) if (item.kind === 'text' && item.markdown) texts.push(item.markdown)
    }
    if (m.t === 'evt' && m.e === 'chat' && (m as ChatViewEvent).tabId === tabId) {
      for (const item of (m as ChatViewEvent).upserts) if (item.kind === 'text' && 'markdown' in item && item.markdown) texts.push(item.markdown)
    }
  }
  return texts
}

describe.skipIf(process.platform === 'win32')('phones on a DevTool server (real relay)', () => {
  const cleanups: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function relay(): Promise<{ relay: RelayServer; sender: CapturingSender }> {
    const store = new MemoryStore()
    const sender = new CapturingSender()
    const gateway = createPushGateway({ store, sealKey: new Uint8Array(randomBytes(32)), sender })
    const r = await startRelayServer({ store, port: 0, host: '127.0.0.1', gateway, limits: { connectionsPerIpPerMinute: 1000 } })
    cleanups.push(() => r.close())
    return { relay: r, sender }
  }

  async function server(relayUrl: string): Promise<TestServer> {
    const s = await startTestServer(relayUrl)
    cleanups.push(() => s.close())
    return s
  }

  function desktop(relayUrl: string): TestDesktop {
    const d = startTestDesktop(relayUrl)
    cleanups.push(() => d.close())
    return d
  }

  function projectDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-server-phone-project-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  /** The server's projects, as a desktop would have saved them, with its `claude` pointed at the fake. */
  async function seed(s: TestServer, dir: string): Promise<void> {
    const client = 'test:seed'
    if (!s.server.clients.hasClient(client)) s.server.clients.registerClient(client, () => {})
    await s.server.clients.call(client, 'save-config', [{ claudeCommand: fakeClaude }])
    const data: ProjectsData = {
      projects: [fixtureProject({
        id: 'p1', name: 'api-server', emoji: '🚀', directory: dir,
        tasks: [{
          id: 't1', name: 'fix-auth',
          tabs: { left: [
            { id: 'tab-chat', type: 'claude-chat', title: 'Claude', sessionId: randomUUID() },
            { id: 'tab-term', type: 'terminal', title: 'Terminal' }
          ] },
          activeTab: { left: 'tab-chat' }
        }, {
          id: 't2', name: 'docs',
          tabs: { left: [{ id: 'tab-docs', type: 'claude-chat', title: 'Claude', sessionId: randomUUID() }] }
        }]
      })],
      tags: [],
      projectOrder: ['p1'],
      pinnedItems: []
    }
    s.server.host.commitProjects(data)
  }

  /** A phone scans the server's QR and is accepted (on the server, as its CLI or a desktop would). */
  async function pairPhone(s: TestServer, invite: MobilePairingInvite, accept: (phoneId: string) => void | Promise<void> = (id) => s.server.host.mobile.accept(id)): Promise<RelayPhone> {
    const phone = new RelayPhone(invite.uri)
    cleanups.push(() => phone.close())
    await waitFor(() => s.server.host.mobile.getState().connection.kind === 'online', 'server phones online')
    await new Promise((resolve) => setTimeout(resolve, 50))
    await phone.connect('pair')
    phone.phone.startHandshake(phone.phone.hello('pair', phone.secret))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello !== null, 'message 2')
    expect(phone.phone.desktopHello?.result).toBe('pending')
    await waitFor(() => s.server.host.mobile.getState().pending?.phoneId === phone.phone.id, 'pending request')
    await accept(phone.phone.id)
    await waitFor(() => inboxEvents(phone.phone.messages).length > 0, 'first inbox')
    return phone
  }

  function caller(phone: RelayPhone) {
    let next = 100
    const res = (id: number) => phone.phone.messages.find((m) => m.t === 'res' && m.id === id)
    return async (op: string, params?: unknown, timeoutMs = 10_000) => {
      const id = next++
      phone.phone.request(id, op, params)
      phone.flush()
      await waitFor(() => res(id) !== undefined, `${op} result`, timeoutMs)
      return res(id) as AppMessage & { ok: boolean; result?: unknown; error?: { code: string; message: string } }
    }
  }

  it('pairs a phone with the server, which says it is a server, and serves the server\'s inbox', { timeout: 30_000 }, async () => {
    const { relay: r } = await relay()
    const s = await server(r.url)
    await seed(s, projectDir())
    const invite = await s.server.host.mobile.startPairing()
    // The QR names the server's relay and the server's name.
    expect(invite.uri).toMatch(/^devtool:\/\/pair\?d=/)
    const phone = await pairPhone(s, invite)

    expect(phone.desktopId).toBe(s.id)
    expect(phone.phone.desktopHello).toMatchObject({ desktopName: 'test-server', app: expect.stringMatching(/^devtool-server\//) })
    expect(isServerApp(phone.phone.desktopHello!.app)).toBe(true)
    expect(phone.phone.desktopHello?.features).toEqual(expect.arrayContaining(['task.new', 'chat.settings', 'task.close', 'tab.close', 'pin', 'task.triage', 'stream.new', 'branches.list', 'chat.commands', 'task.land']))

    const inbox = inboxEvents(phone.phone.messages)[0].inbox
    expect(inbox.desktop).toEqual({ id: s.id, name: 'test-server' })
    expect(inbox.projects.map((p) => p.name)).toEqual(['api-server'])
    expect(inbox.projects[0].tasks.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(inbox.projects[0].remote).toBe(false)
    const call = caller(phone)
    expect(await call('inbox.get')).toMatchObject({ ok: true, result: { desktop: { id: s.id }, projects: [{ id: 'p1' }] } })
    expect(s.server.host.mobile.getState().devices).toMatchObject([{ id: phone.phone.id, name: 'Test iPhone', online: true }])
    // The server's state goes to its desktops on a channel of its own.
    expect(s.server.host.getConfig().mobile).toMatchObject({ enabled: true })
  })

  it('runs a server chat from the phone: send, a permission prompt pushed and answered, done pushed, the reply on screen', { timeout: 60_000 }, async () => {
    const { relay: r, sender } = await relay()
    const s = await server(r.url)
    await seed(s, projectDir())
    const phone = await pairPhone(s, await s.server.host.mobile.startPairing())
    const call = caller(phone)

    // Push registration (SPEC.md §7.1, §7.4), as the phone does after pairing.
    const token = 'cd'.repeat(32)
    const body = signPushRegister(phone.phone.ed.priv, phone.phone.ed.pub, token, 'sandbox', Math.floor(Date.now() / 1000))
    const registered = await fetch(`${r.url.replace(/^ws/, 'http')}/v1/push/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const { cap } = await registered.json() as { cap: string }
    const key = new Uint8Array(randomBytes(32))
    const keyId = new Uint8Array(randomBytes(8))
    expect(await call('push.register', { cap, key: b64uEncode(key), keyId: b64uEncode(keyId), kinds: ['permission', 'question', 'done'] })).toMatchObject({ ok: true })
    await waitFor(() => s.server.host.mobile.getState().devices[0]?.push === true, 'registration stored')
    const opened = (i: number): PushPayload | null => openPushPayload(key, sender.requests[i].data)

    // A message that makes (fake) Claude ask to run Bash, sent while the chat isn't open on the phone.
    expect(await call('chat.send', { tabId: 'tab-chat', text: 'deploy it [permission]' }, 30_000)).toMatchObject({ ok: true })
    await waitFor(() => sender.requests.length >= 1, 'permission push', 20_000)
    const permission = opened(0)
    expect(permission).toMatchObject({ kind: 'permission', desktop: s.id, tab: 'tab-chat', title: 'api-server / fix-auth', body: 'Bash · echo from-fake-claude' })

    // Allow from the phone (as the notification's Allow does): the turn goes on, and a done push follows.
    expect(await call('chat.answer', { tabId: 'tab-chat', promptId: permission!.prompt, answer: { behavior: 'allow' } })).toMatchObject({ ok: true })
    await waitFor(() => sender.requests.length >= 2, 'done push', 20_000)
    expect(opened(1)).toMatchObject({ kind: 'done', tab: 'tab-chat', body: 'echo: deploy it [permission] (allow)' })

    // The phone opens the chat and sees the reply; the other chat ops answer too.
    const open = await call('chat.open', { tabId: 'tab-chat' }, 20_000)
    expect(open).toMatchObject({ ok: true, result: { view: { tabId: 'tab-chat', title: 'Claude' } } })
    expect(chatTexts(phone.phone.messages, 'tab-chat')).toContain('echo: deploy it [permission] (allow)')
    expect(await call('chat.send', { tabId: 'tab-chat', text: 'and again' }, 20_000)).toMatchObject({ ok: true })
    await waitFor(() => chatTexts(phone.phone.messages, 'tab-chat').includes('echo: and again'), 'second reply', 20_000)
    expect(await call('chat.settings', { tabId: 'tab-chat', mode: 'plan' })).toMatchObject({ ok: true })
    const commands = await call('chat.commands', { tabId: 'tab-chat' })
    expect((commands.result as { commands: { name: string }[] }).commands.map((c) => c.name)).toEqual(expect.arrayContaining(['btw', 'permissions']))
    expect(await call('chat.interrupt', { tabId: 'tab-chat' })).toMatchObject({ ok: true })
    expect(await call('chat.detail', { tabId: 'tab-chat', itemId: 'no-such-item' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(await call('chat.image', { tabId: 'tab-chat', itemId: 'no-such-item', index: 0 })).toMatchObject({ ok: false, error: { code: 'not-found' } })
    const view = (open.result as { view: { items: { id: string }[] } }).view
    expect(await call('chat.earlier', { tabId: 'tab-chat', before: view.items.at(-1)!.id })).toMatchObject({ ok: true })
    // The server's permission rules, in the project folder on the server.
    expect(await call('chat.permissions', { tabId: 'tab-chat' })).toMatchObject({ ok: true, result: { sources: expect.any(Array) } })
    expect(await call('chat.close', { tabId: 'tab-chat' })).toMatchObject({ ok: true })
  })

  it('does every task op on the server: new task in a stream, pin, triage, tab and task close, branches and a worktree stream', { timeout: 60_000 }, async () => {
    const { relay: r } = await relay()
    const s = await server(r.url)
    const dir = projectDir()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first')
    await seed(s, dir)
    const phone = await pairPhone(s, await s.server.host.mobile.startPairing())
    const call = caller(phone)
    const project = () => s.server.host.getProjectsData().projects.find((p) => p.id === 'p1')!
    const latest = () => inboxEvents(phone.phone.messages).at(-1)!.inbox

    // A stream in the project folder, then a task in it with a chat started on the prompt.
    const stream = await call('stream.new', { projectId: 'p1', name: 'side', worktree: false })
    expect(stream).toMatchObject({ ok: true })
    const streamId = (stream.result as { streamId: string }).streamId
    const created = await call('task.new', { projectId: 'p1', streamId, prompt: 'hello server', mode: 'acceptEdits' }, 30_000)
    expect(created).toMatchObject({ ok: true })
    const { taskId, tabId } = created.result as { taskId: string; tabId: string }
    expect(project().streams.find((st) => st.id === streamId)?.tasks.map((t) => t.id)).toEqual([taskId])
    await waitFor(() => latest().projects[0].tasks.some((t) => t.id === taskId && t.streamId === streamId), 'new task in the inbox', 5000)
    expect(await call('chat.open', { tabId }, 20_000)).toMatchObject({ ok: true })
    await waitFor(() => chatTexts(phone.phone.messages, tabId).includes('echo: hello server'), 'the task\'s first reply', 20_000)

    // The project's branches, and a stream with a worktree of its own made on the server.
    expect(await call('branches.list', { projectId: 'p1' })).toMatchObject({ ok: true, result: { branches: ['main'], defaultBase: 'main' } })
    const worktree = await call('stream.new', { projectId: 'p1', name: '0.5.0', worktree: true }, 30_000)
    expect(worktree).toMatchObject({ ok: true })
    const branchStream = project().streams.find((st) => st.id === (worktree.result as { streamId: string }).streamId)
    expect(branchStream?.workspace?.branchName).toBe('0.5.0')
    expect(fs.existsSync(branchStream!.workspace!.worktreePath)).toBe(true)

    // Pins and triage live in the server's own data (the phone reads them back).
    expect(await call('pin.set', { projectId: 'p1', taskId: 't2', pinned: true })).toMatchObject({ ok: true })
    expect(s.server.host.getProjectsData().pinnedItems).toEqual([{ type: 'task', projectId: 'p1', streamId: 'main-p1', taskId: 't2' }])
    await waitFor(() => latest().pinned?.some((p) => p.taskId === 't2') === true, 'pin in the inbox', 5000)
    expect(await call('task.triage', { taskId: 't2', action: 'settle' })).toMatchObject({ ok: true })
    await waitFor(() => latest().projects[0].tasks.find((t) => t.id === 't2')?.settledAt !== undefined, 'settled in the inbox', 5000)

    // Close a tab, then a task (it goes to the server's archive).
    expect(await call('tab.close', { tabId: 'tab-term' })).toMatchObject({ ok: true })
    expect(project().streams[0].tasks.find((t) => t.id === 't1')?.panes.flatMap((p) => p.tabs).map((t) => t.id)).toEqual(['tab-chat'])
    expect(await call('task.close', { taskId: 't1' })).toMatchObject({ ok: true, result: { closed: true } })
    expect(project().streams.flatMap((st) => st.tasks).some((t) => t.id === 't1')).toBe(false)
    await waitFor(() => !latest().projects[0].tasks.some((t) => t.id === 't1'), 'closed task leaves the inbox', 5000)
    // A task that never existed is not-found, as on a desktop.
    expect(await call('task.close', { taskId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('serves a desktop and a phone on one server socket without either noticing the other, and still tells a forgotten desktop', { timeout: 60_000 }, async () => {
    const { relay: r } = await relay()
    const s = await server(r.url)
    await seed(s, projectDir())
    const d = desktop(r.url)
    await pairByCode(d, s)
    const phone = await pairPhone(s, await s.server.host.mobile.startPairing())
    const call = caller(phone)

    // Both talk to the server at once: the desktop's link calls and the phone's ops.
    const [projects, inbox] = await Promise.all([
      d.hub.call(s.id, 'win:1', 'load-projects', [], { focused: true }) as Promise<{ local: { data: ProjectsData } }>,
      call('inbox.get')
    ])
    expect(projects.local.data.projects.map((p) => p.id)).toEqual(['p1'])
    expect(inbox).toMatchObject({ ok: true, result: { projects: [{ id: 'p1' }] } })
    // A terminal on the server for the desktop, while the phone sees its tasks change.
    await d.hub.call(s.id, 'win:1', 'pty-spawn', ['tab-term', '/bin/sh', os.tmpdir(), 80, 24, ['-c', 'echo desktop-and-phone; exec cat'], {}, undefined, undefined], { focused: true })
    await waitFor(() => d.ptyText('tab-term').includes('desktop-and-phone'), 'pty output')
    expect(await call('pin.set', { projectId: 'p1', pinned: true })).toMatchObject({ ok: true })
    await waitFor(() => d.events.some((e) => e.ch === 'projects-updated'), 'the desktop hears the phone\'s pin')
    expect(d.status(s.id)?.state).toBe('online')
    expect(s.link.connectedDesktops()).toEqual([d.identity.get().id])
    // The desktop heard the server's phone state, never the plain mobile channel.
    expect(d.events.some((e) => e.ch === 'server-mobile-state-changed')).toBe(true)
    expect(d.events.some((e) => e.ch === 'mobile-state-changed')).toBe(false)
    expect(phone.relayMessages.filter((m) => m.t === 'error')).toEqual([])

    // The server forgets the desktop (its record only): with phones on the socket, the
    // desktop's next handshake is still recognised as a link one and hears unknown-device.
    s.link.desktops.remove(d.identity.get().id)
    s.link.stop()
    s.server.host.mobile.setEnabled(false)
    await waitFor(() => d.status(s.id)?.state === 'offline', 'server offline')
    s.server.host.mobile.setEnabled(true)
    s.link.start()
    await waitFor(() => d.status(s.id)?.problem === 'unknown-device', 'unknown-device', 20_000)
    expect(s.log.some((line) => line.includes('handshake result=unknown-device'))).toBe(true)
    // The phone comes back on its own (resume) and is served as before.
    await phone.connect('resume')
    phone.phone.startHandshake(phone.phone.hello('resume'))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello?.result === 'ok', 'phone resumed')
    expect(await call('inbox.get')).toMatchObject({ ok: true })
  })

  it('shares the relay\'s one offer between a phone QR and a desktop code', { timeout: 60_000 }, async () => {
    const { relay: r } = await relay()
    const s = await server(r.url)
    await seed(s, projectDir())
    const first = desktop(r.url)
    await pairByCode(first, s)

    // A phone QR, then `devtool-server pair`: the code takes the slot and the QR goes.
    const staleInvite = await s.server.host.mobile.startPairing()
    await waitFor(() => s.server.host.mobile.getState().invite !== null, 'QR live')
    const { code } = await s.link.createPairingCode()
    await waitFor(() => s.server.host.mobile.getState().invite === null, 'QR dropped')
    expect(s.log.some((line) => line.includes('pairing QR replaced by another offer'))).toBe(true)
    // A phone with the dropped QR is refused by the relay; the desktop with the code pairs.
    const late = new RelayPhone(staleInvite.uri)
    cleanups.push(() => late.close())
    await late.connect('pair')
    await waitFor(() => late.relayMessages.some((m) => m.t === 'error' && m.code === 'forbidden'), 'relay refuses the old QR')
    const second = desktop(r.url)
    await second.hub.pairWithCode(code)
    await waitFor(() => second.status(s.id)?.state === 'online', 'second desktop online', 10_000)

    // The other way round: a new code, then a phone QR takes the slot and the code is cancelled.
    const { code: dropped } = await s.link.createPairingCode()
    const invite = await s.server.host.mobile.startPairing()
    expect(s.link.codeState()).toMatchObject({ code: dropped, state: 'cancelled' })
    const third = desktop(r.url)
    await expect(third.hub.pairWithCode(dropped)).rejects.toThrow()
    const phone = await pairPhone(s, invite)
    expect(inboxEvents(phone.phone.messages)[0].inbox.desktop.id).toBe(s.id)
    expect(s.link.connectedDesktops().sort()).toEqual([first.identity.get().id, second.identity.get().id].sort())
  })

  it('pairs a phone from a desktop\'s Settings › Servers: the state over the link, Accept, Revoke', { timeout: 60_000 }, async () => {
    const { relay: r } = await relay()
    const s = await server(r.url)
    await seed(s, projectDir())
    const d = desktop(r.url)
    await pairByCode(d, s)
    const hubCall = (ch: string, ...args: unknown[]) => d.hub.call(s.id, 'win:1', ch, [s.id, ...args], { focused: true })
    const states = () => d.events.filter((e) => e.ch === 'server-mobile-state-changed').map((e) => e.args[0] as MobileState)

    expect(await hubCall('server-mobile-get-state')).toMatchObject({ enabled: false, devices: [] })
    const invite = await hubCall('server-mobile-start-pairing') as MobilePairingInvite
    await waitFor(() => states().some((st) => st.invite?.uri === invite.uri), 'the server pushes its QR')
    expect(states().at(-1)).toMatchObject({ enabled: true, desktopName: 'test-server', connection: { kind: 'online' } })

    const phone = await pairPhone(s, invite, async (phoneId) => {
      await waitFor(() => states().some((st) => st.pending?.phoneId === phoneId), 'the server pushes the request')
      expect(states().find((st) => st.pending)?.pending).toMatchObject({ name: 'Test iPhone', online: true })
      await expect(hubCall('server-mobile-accept', 'f'.repeat(32))).rejects.toThrow(/No pairing request from that phone/)
      const accepted = await hubCall('server-mobile-accept', phoneId) as MobileState
      expect(accepted.devices).toMatchObject([{ id: phoneId, name: 'Test iPhone' }])
    })
    expect(phone.phone.messages).toContainEqual({ t: 'evt', e: 'pairing', status: 'accepted' })
    await waitFor(() => states().at(-1)?.devices.length === 1 && states().at(-1)?.pending === null, 'the server pushes the paired phone')

    const revoked = await hubCall('server-mobile-revoke', phone.phone.id) as MobileState
    expect(revoked.devices).toEqual([])
    await waitFor(() => phone.relayMessages.some((m) => m.t === 'peer' && m.state === 'revoked'), 'the phone hears the revoke')
    expect(phone.phone.messages.at(-1)).toEqual({ t: 'evt', e: 'pairing', status: 'revoked' })
    await waitFor(() => states().at(-1)?.devices.length === 0, 'the server pushes the revoke')
  })
})

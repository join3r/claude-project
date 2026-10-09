import { createHash } from 'crypto'
import { once } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RelayServer } from '../relay/src/server.ts'
import { sourceBytes } from '../src/main/host/link/diagnostic-streams'
import type { ServerConnectionKind } from '../src/shared/servers'
import type { ProjectsData } from '../src/shared/types'
import { pairByCode, startTestDesktop, startTestRelay, startTestServer, waitFor, type TestDesktop, type TestServer } from './helpers/host-link'
import { MobileService } from '../src/main/mobile/mobile-service'
import { PairingsStore } from '../src/main/mobile/pairings-store'
import { createNoiseChannelFactory } from '../src/main/mobile/channel'
import { createInvite } from '../src/main/mobile/invite'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'
import { DEFAULT_MOBILE_CONFIG, type MobileConfig } from '../src/shared/mobile'
import { RelayPhone } from './helpers/relay-phone'
import type { AppMessage } from '../protocol/ts/index.ts'

/**
 * The host link end to end (protocol/SERVER.md): a desktop's ServerHub, the real
 * relay on an ephemeral port, and a server's host with its ServerLink, all in
 * process. PTYs are real, so the server side is Linux and macOS only.
 */

const cleanups: (() => unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function relay(limits: Parameters<typeof startTestRelay>[0] = {}): Promise<RelayServer> {
  const { relay } = await startTestRelay(limits)
  cleanups.push(() => relay.close())
  return relay
}

function desktop(relayUrl: string, options: Parameters<typeof startTestDesktop>[1] = {}): TestDesktop {
  const d = startTestDesktop(relayUrl, options)
  cleanups.push(() => d.close())
  return d
}

async function server(relayUrl: string, overrides: Parameters<typeof startTestServer>[1] = {}): Promise<TestServer> {
  const s = await startTestServer(relayUrl, overrides)
  cleanups.push(() => s.close())
  return s
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-link-cwd-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** pty-spawn's arguments: a `/bin/sh -c <script>` tab. */
function shTab(tabId: string, cwd: string, script: string): unknown[] {
  return [tabId, '/bin/sh', cwd, 80, 24, ['-c', script], {}, undefined, undefined]
}

/** Records every state a server goes through on the desktop, starting with the current one. */
function trackStates(d: TestDesktop, serverId: string): ServerConnectionKind[] {
  const seen: ServerConnectionKind[] = [d.status(serverId)!.state]
  d.hub.onStateChange((state) => {
    const s = state.servers.find((x) => x.id === serverId)?.state
    if (s && seen.at(-1) !== s) seen.push(s)
  })
  return seen
}

describe.skipIf(process.platform === 'win32')('host link end to end (real relay)', () => {
  it('spawns a PTY on the server and streams its output back, batched and in order', { timeout: 30_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const d = desktop(r.url)
    await pairByCode(d, s)
    const cwd = tempDir()
    const desktopId = d.identity.get().id

    const attach = await d.hub.call(s.id, 'win:1', 'pty-spawn', shTab('tab-1', cwd, 'for i in $(seq 1 300); do echo "line $i"; done; echo done-marker; exec cat'), { focused: true }) as { exitCode: number | null; cols: number }
    expect(attach).toMatchObject({ exitCode: null, cols: 80 })
    expect(s.server.clients.hasClient(`link:${desktopId}:win:1`)).toBe(true)
    await waitFor(() => d.ptyText('tab-1').includes('done-marker'), 'pty output')
    const text = d.ptyText('tab-1', 'win:1').replace(/\r/g, '')
    expect(text).toContain(Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'))
    // 300 echoes arrive in a handful of batched messages, not one each.
    expect(d.events.filter((e) => e.ch === 'pty-data' && e.args[0] === 'tab-1').length).toBeLessThan(30)

    // Typing goes through, and the echo comes back.
    await d.hub.call(s.id, 'win:1', 'pty-write', ['tab-1', 'typed-on-the-desktop\r'])
    await waitFor(() => d.ptyText('tab-1').includes('typed-on-the-desktop'), 'echo')

    // A process that exits: all of its output arrives before its pty-exit.
    await d.hub.call(s.id, 'win:1', 'pty-spawn', shTab('tab-2', cwd, 'seq 1 5000'))
    await waitFor(() => d.events.some((e) => e.ch === 'pty-exit' && e.args[0] === 'tab-2'), 'pty-exit')
    const tab2 = d.events.filter((e) => e.args[0] === 'tab-2')
    expect(tab2.at(-1)).toMatchObject({ ch: 'pty-exit', args: ['tab-2', 0] })
    const numbers = d.ptyText('tab-2').replace(/\r/g, '').trim().split('\n').map(Number)
    expect(numbers).toEqual(Array.from({ length: 5000 }, (_, i) => i + 1))
  })

  it('sends a broadcast once per desktop, to every window', { timeout: 30_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const d = desktop(r.url)
    await pairByCode(d, s)
    const { local: { revision, data } } = await d.hub.call(s.id, 'win:1', 'load-projects') as { local: { revision: number; data: ProjectsData } }
    await d.hub.call(s.id, 'win:2', 'load-config')
    const saved = await d.hub.call(s.id, 'win:2', 'save-projects', ['local', { baseRevision: revision, data: { ...data, tags: [{ id: 'tag-1', name: 'linked', color: '#123456' }] } }]) as { ok: boolean }
    expect(saved.ok).toBe(true)
    await waitFor(() => d.events.some((e) => e.ch === 'projects-updated'), 'projects-updated')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const updates = d.events.filter((e) => e.ch === 'projects-updated')
    expect(updates).toHaveLength(1)
    expect(updates[0].client).toBe('*')
    // A window closing on the desktop lets the server forget it.
    const desktopId = d.identity.get().id
    d.hub.detachClient('win:2')
    await waitFor(() => !s.server.clients.hasClient(`link:${desktopId}:win:2`), 'win:2 unregistered')
    expect(s.server.clients.hasClient(`link:${desktopId}:win:1`)).toBe(true)
    // Unknown channels and local-only ones are refused, not crashed on.
    await expect(d.hub.call(s.id, 'win:1', 'no-such-channel')).rejects.toMatchObject({ code: 'unsupported' })
    await expect(d.hub.call(s.id, 'win:1', 'scrollback-save-sync', ['t', ''])).rejects.toMatchObject({ code: 'unsupported' })
    await expect(d.hub.call(s.id, 'win:1', 'fb-read-file', [42])).rejects.toMatchObject({ code: 'remote-error', message: expect.stringMatching(/Invalid IPC argument/) })
  })

  it('streams 50 MB into a slow reader without growing the relay\'s buffers or dropping the link', { timeout: 120_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const d = desktop(r.url)
    await pairByCode(d, s)
    const states = trackStates(d, s.id)

    const total = 50 * 1024 * 1024
    const chunk = Buffer.from(sourceBytes(0, 1024 * 1024, 5))
    const hash = createHash('sha256')
    let maxQueued = 0
    const sampler = setInterval(() => { maxQueued = Math.max(maxQueued, r.relay.stats().queued) }, 5)
    const started = Date.now()
    // About 60 KB per read, then 6 ms asleep: slower than the relay would carry it.
    const stream = d.hub.openStream(s.id, 'sink', { delayMs: 6 })
    const replyChunks: Buffer[] = []
    stream.on('data', (c: Buffer) => replyChunks.push(c))
    for (let sent = 0; sent < total; sent += chunk.length) {
      hash.update(chunk)
      if (!stream.write(chunk)) await once(stream, 'drain')
    }
    stream.end()
    await once(stream, 'end')
    clearInterval(sampler)
    const seconds = (Date.now() - started) / 1000
    const reply = JSON.parse(Buffer.concat(replyChunks).toString()) as { bytes: number; sha256: string }
    expect(reply).toEqual({ bytes: total, sha256: hash.digest('hex') })
    // Credit keeps about one 256 KiB window in flight; the relay never comes near its 4 MiB mark.
    expect(maxQueued).toBeLessThan(1024 * 1024)
    expect(r.relay.stats().dropped).toBe(0)
    expect(states).toEqual(['online'])
    expect(d.status(s.id)?.state).toBe('online')
    console.log(`50 MB to a slow reader: ${seconds.toFixed(1)} s, ${(50 / seconds).toFixed(1)} MiB/s, relay queue max ${(maxQueued / 1024).toFixed(0)} KiB`)
  })

  it('holds a flooding PTY back while the relay throttles it, and delivers every byte in order', { timeout: 120_000 }, async () => {
    // 1 MiB/s for hosts: the flood is far faster, so the server's socket backs up.
    const r = await relay({ hostBytesPerSecond: 1024 * 1024, hostBytesBurst: 256 * 1024 })
    const s = await server(r.url)
    const d = desktop(r.url)
    await pairByCode(d, s)
    const states = trackStates(d, s.id)
    const cwd = tempDir()
    let maxBuffered = 0
    const sampler = setInterval(() => { maxBuffered = Math.max(maxBuffered, s.link.socketBuffered()) }, 2)
    // About 4.6 MB: more than loopback socket buffers absorb, so the WebSocket's own
    // queue (what the server watches) really grows past its high-water mark.
    const lines = 600_000
    const started = Date.now()
    await d.hub.call(s.id, 'win:1', 'pty-spawn', shTab('flood', cwd, `seq 1 ${lines}; echo flood-done`))
    await waitFor(() => d.ptyText('flood').includes('flood-done'), 'the whole flood', 90_000)
    clearInterval(sampler)
    const seconds = (Date.now() - started) / 1000
    const numbers = d.ptyText('flood').replace(/\r/g, '').trim().split('\n')
    expect(numbers.pop()).toBe('flood-done')
    expect(numbers.length).toBe(lines)
    for (let i = 0; i < lines; i++) if (numbers[i] !== String(i + 1)) throw new Error(`line ${i + 1} is ${numbers[i]}`)
    expect(s.link.stats.holds).toBeGreaterThan(0)
    expect(s.link.stats.releases).toBeGreaterThan(0)
    expect(s.server.host.terminalOutputHeldBy(`link:${d.identity.get().id}`)).toEqual([])
    // The PTY waits instead of the server queueing megabytes.
    expect(maxBuffered).toBeLessThan(2 * 1024 * 1024)
    expect(r.relay.stats().dropped).toBe(0)
    expect(states).toEqual(['online'])
    const bytes = d.ptyText('flood').length
    console.log(`flood: ${(bytes / 1024 / 1024).toFixed(1)} MB in ${seconds.toFixed(1)} s, holds=${s.link.stats.holds}, server socket max ${(maxBuffered / 1024).toFixed(0)} KiB`)
  })

  it('reconnects after the link drops and reattaches the PTY with its scrollback', { timeout: 30_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const d = desktop(r.url)
    await pairByCode(d, s)
    const cwd = tempDir()
    const desktopId = d.identity.get().id
    await d.hub.call(s.id, 'win:1', 'pty-spawn', shTab('tab-r', cwd, 'echo before-the-drop; exec cat'))
    await waitFor(() => d.ptyText('tab-r').includes('before-the-drop'), 'first output')
    // A pending call fails fast when the link goes.
    const pending = d.hub.call(s.id, 'win:1', 'pty-write', ['tab-r', 'x'])

    // The desktop's socket drops (a network blip): the server lets go of its windows.
    d.client.connect(r.url)
    await expect(pending).resolves.toBeUndefined().catch(() => {})
    await waitFor(() => d.status(s.id)?.state !== 'online', 'link down', 5000).catch(() => {})
    await waitFor(() => d.status(s.id)?.state === 'online', 'link back', 15_000)
    await waitFor(() => !s.server.clients.hasClient(`link:${desktopId}:win:1`), 'old client gone')
    await expect(d.hub.call(s.id, 'win:1', 'pty-write', ['tab-r', 'x'])).resolves.toBeUndefined()

    const attach = await d.hub.call(s.id, 'win:1', 'pty-spawn', shTab('tab-r', cwd, 'echo a-new-process')) as { scrollback: string; exitCode: number | null }
    expect(attach.exitCode).toBeNull()
    expect(attach.scrollback).toContain('before-the-drop')
    expect(attach.scrollback).not.toContain('a-new-process')
    const before = d.ptyText('tab-r').length
    await d.hub.call(s.id, 'win:1', 'pty-write', ['tab-r', 'after-the-drop\r'])
    await waitFor(() => d.ptyText('tab-r').slice(before).includes('after-the-drop'), 'output after reattach')
  })

  it('fails calls fast with server-offline while the server is gone, and comes back with it', { timeout: 30_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const d = desktop(r.url)
    await pairByCode(d, s)
    s.link.stop()
    await waitFor(() => d.status(s.id)?.state === 'offline', 'server offline')
    await expect(d.hub.call(s.id, 'win:1', 'load-config')).rejects.toMatchObject({ code: 'server-offline' })
    expect(() => d.hub.openStream(s.id, 'echo')).toThrow(/offline/)
    s.link.start()
    await waitFor(() => d.status(s.id)?.state === 'online', 'server back', 15_000)
    await expect(d.hub.call(s.id, 'win:1', 'load-config')).resolves.toMatchObject({ claudeCommand: '' })
    expect(d.status(s.id)?.build).toMatchObject({ version: expect.any(String), commit: 'dev' })
  })

  it('negotiates the version: a newer desktop or a newer server is incompatible, with the side to update', { timeout: 30_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const future = desktop(r.url, { version: { v: 3, min: 2 } })
    await pairByCode(future, s, 'incompatible')
    expect(future.status(s.id)).toMatchObject({ state: 'incompatible', update: 'server' })
    await expect(future.hub.call(s.id, 'win:1', 'load-config')).rejects.toMatchObject({ code: 'server-offline' })

    const newer = await server(r.url, { version: { v: 3, min: 2 } })
    const d = desktop(r.url)
    await pairByCode(d, newer, 'incompatible')
    expect(d.status(newer.id)).toMatchObject({ state: 'incompatible', update: 'desktop' })
    expect(newer.link.connectedDesktops()).toEqual([])
  })

  it('answers a desktop it has no pairing for with unknown-device', { timeout: 30_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const stranger = desktop(r.url)
    await pairByCode(stranger, s)
    // The server forgets it (its record only; the relay pair stays), then the link starts over.
    s.link.desktops.remove(stranger.identity.get().id)
    s.link.stop()
    await waitFor(() => stranger.status(s.id)?.state === 'offline', 'server offline')
    s.link.start()
    await waitFor(() => stranger.status(s.id)?.problem === 'unknown-device', 'unknown-device', 15_000)
    expect(stranger.status(s.id)).toMatchObject({ state: 'offline', error: expect.stringMatching(/does not know this desktop/) })
    expect(s.link.connectedDesktops()).toEqual([])
    expect(s.log.some((line) => line.includes('handshake result=unknown-device'))).toBe(true)
  })

  it('carries a phone and a server on one desktop socket without either noticing the other', { timeout: 30_000 }, async () => {
    const r = await relay()
    const s = await server(r.url)
    const d = desktop(r.url)
    await pairByCode(d, s)

    // The desktop's mobile service, on the same relay socket and identity as its servers.
    let config: MobileConfig = { ...DEFAULT_MOBILE_CONFIG, relayUrl: r.url }
    const mobileDir = path.join(d.dir, 'mobile')
    const mobile = new MobileService({
      getConfig: () => config,
      saveConfig: (next) => { config = next },
      projects: { peek: () => ({ projects: [], tags: [], projectOrder: [], pinnedItems: [] }), subscribe: () => () => {} },
      activity: new TabActivityRegistry(),
      pairings: new PairingsStore(mobileDir),
      getDesktopId: () => d.identity.peekId(),
      defaultDesktopName: () => 'test-mac',
      createTransport: () => d.mux.mobileTransport(),
      channels: createNoiseChannelFactory({ staticKey: () => d.identity.get().x25519, app: 'devtool/test', desktopName: () => 'test-mac', log: () => {} }),
      createInvite: (options) => createInvite(d.identity.get(), options),
      broadcastState: () => {},
      log: () => {}
    })
    mobile.start()
    cleanups.push(() => mobile.stop())
    const invite = await mobile.startPairing()
    await waitFor(() => mobile.getState().connection.kind === 'online', 'mobile online')
    await new Promise((resolve) => setTimeout(resolve, 50))

    // A phone pairs (JSON frames on its side; the desktop's socket is binary) while the server link stays up.
    const phone = new RelayPhone(invite.uri)
    cleanups.push(() => phone.close())
    await phone.connect('pair')
    phone.phone.startHandshake(phone.phone.hello('pair', phone.secret))
    phone.flush()
    await waitFor(() => phone.phone.desktopHello?.result === 'pending', 'phone pending')
    mobile.accept(phone.phone.id)
    await waitFor(() => phone.phone.messages.some((m: AppMessage) => m.t === 'evt' && m.e === 'inbox'), 'phone inbox')
    phone.phone.request(1, 'inbox.get')
    phone.flush()
    await waitFor(() => phone.phone.messages.some((m: AppMessage) => m.t === 'res' && m.id === 1), 'inbox.get answered')

    // Meanwhile the server link works, and neither side saw the other's frames.
    expect(d.status(s.id)?.state).toBe('online')
    await expect(d.hub.call(s.id, 'win:1', 'load-config')).resolves.toMatchObject({ claudeCommand: '' })
    expect(s.log.some((line) => line.includes('unreadable'))).toBe(false)
    expect(d.log.some((line) => line.includes('bad message') || line.includes('unreadable'))).toBe(false)
    expect(phone.relayMessages.filter((m) => m.t === 'error')).toEqual([])

    // Mobile off: the socket stays up for the server.
    mobile.setEnabled(false)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(d.client.getState().kind).toBe('online')
    await expect(d.hub.call(s.id, 'win:1', 'load-config')).resolves.toMatchObject({ claudeCommand: '' })
  })
})

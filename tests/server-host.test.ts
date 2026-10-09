import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ServerHost } from '../src/server/server-host'
import type { PowerSaveApi } from '../src/main/sleep-blocker'
import type { ProjectsData } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

/**
 * The server's HostServices with its Node adapters, driven in process through the
 * client registry the way the host link will drive it: real PTYs, a real file read
 * and a chat against a fake `claude`. The server is Linux and macOS only.
 */

type Push = { channel: string; args: unknown[] }

class TestClient {
  readonly pushes: Push[] = []
  private waiters: { match: (push: Push) => boolean; resolve: (push: Push) => void }[] = []

  constructor(readonly id: string) {}

  readonly sink = (channel: string, args: unknown[]): void => {
    const push = { channel, args }
    this.pushes.push(push)
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(push)) continue
      this.waiters = this.waiters.filter(w => w !== waiter)
      waiter.resolve(push)
    }
  }

  /** The first push (already received or still to come) that matches. */
  waitFor(match: (push: Push) => boolean, timeoutMs = 10_000): Promise<Push> {
    const seen = this.pushes.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.id}: no matching push within ${timeoutMs} ms`)), timeoutMs)
      this.waiters.push({ match, resolve: (push) => { clearTimeout(timer); resolve(push) } })
    })
  }

  /** Everything a PTY tab printed to this client so far. */
  ptyText(tabId: string): string {
    return this.pushes
      .filter(p => p.channel === 'pty-data' && p.args[0] === tabId)
      .map(p => String(p.args[1]))
      .join('')
  }
}

const noPowerSave: PowerSaveApi = { start: () => 1, stop: () => {}, isStarted: () => false }

describe.skipIf(process.platform === 'win32')('server host (in process)', () => {
  let home: string
  let projectDir: string
  let server: ServerHost
  const a = new TestClient('test:a')
  const b = new TestClient('test:b')

  const ptyText = (client: TestClient, tabId: string, text: string) =>
    client.waitFor(() => client.ptyText(tabId).includes(text))

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-server-home-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-server-project-'))
    fs.writeFileSync(path.join(projectDir, 'hello.txt'), 'hello from the server\n')
    // Imported here, not at the top: the host loads node-pty, which a skipped
    // platform should never have to.
    const { startServerHost } = await import('../src/server/server-host')
    const { loadServerManifest, serverPaths } = await import('../src/server/server-env')
    server = await startServerHost({
      paths: serverPaths({ DEVTOOL_SERVER_HOME: home }),
      manifest: loadServerManifest(path.resolve('src/server')),
      bundleDir: path.resolve('resources'),
      powerSave: noPowerSave,
      log: () => {}
    })
    server.clients.registerClient(a.id, a.sink)
  })

  afterAll(async () => {
    await server?.shutdown()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('keeps its data under DEVTOOL_SERVER_HOME, in a 0700 data dir', () => {
    const dataDir = path.join(home, 'data')
    expect(server.env.configDir).toBe(dataDir)
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700)
    expect(server.env.appVersion).toBe(JSON.parse(fs.readFileSync('package.json', 'utf8')).version)
    expect(server.env.manifest.commit).toBe('dev')
  })

  it('serves the host channels to registered clients only', async () => {
    expect(server.clients.channels()).toEqual(expect.arrayContaining(['load-projects', 'pty-spawn', 'pty-write', 'fb-read-file', 'chat-attach']))
    expect(await server.clients.call(a.id, 'load-config')).toMatchObject({ claudeCommand: '' })
    await expect(server.clients.call('test:stranger', 'load-config')).rejects.toThrow(/refused/)
    await expect(server.clients.call(a.id, 'fb-read-file', [42])).rejects.toThrow(/Invalid IPC argument/)
  })

  it('runs a PTY, streams its output and reattaches a second client with the scrollback', async () => {
    const tabId = 'pty-tab-1'
    const attach = await server.clients.call(a.id, 'pty-spawn', [
      tabId, '/bin/sh', projectDir, 80, 24, ['-c', 'echo server-pty-says-hi; exec cat'], {}, undefined, undefined
    ]) as { scrollback: string; exitCode: number | null }
    expect(attach.exitCode).toBeNull()
    await ptyText(a, tabId, 'server-pty-says-hi')

    server.clients.registerClient(b.id, b.sink)
    const reattach = await server.clients.call(b.id, 'pty-spawn', [
      tabId, '/bin/sh', projectDir, 100, 30, ['-c', 'echo spawned-twice'], {}, undefined, undefined
    ]) as { cols: number; rows: number; scrollback: string; exitCode: number | null }
    // The running process, not a new one: the first client's size and output.
    expect(reattach).toMatchObject({ cols: 80, rows: 24, exitCode: null })
    expect(reattach.scrollback).toContain('server-pty-says-hi')

    // `cat` echoes the input back, to both clients.
    await server.clients.call(b.id, 'pty-write', [tabId, 'typed-by-b\r'])
    await ptyText(a, tabId, 'typed-by-b')
    await ptyText(b, tabId, 'typed-by-b')

    // A client that goes away stops getting the tab's output; the PTY lives on.
    server.clients.unregisterClient(b.id)
    const before = b.pushes.length
    await server.clients.call(a.id, 'pty-write', [tabId, 'after-b-left\r'])
    await ptyText(a, tabId, 'after-b-left')
    expect(b.pushes.length).toBe(before)

    await server.clients.call(a.id, 'pty-kill', [tabId])
    expect(fs.readFileSync(path.join(home, 'data/scrollback', `${tabId}.txt`), 'utf8')).toContain('after-b-left')
  })

  it('reads files only inside a project the server has', async () => {
    await expect(server.clients.call(a.id, 'fb-read-file', [projectDir, 'hello.txt'])).rejects.toThrow()

    const { local: { revision, data } } = await server.clients.call(a.id, 'load-projects') as { local: { revision: number; data: ProjectsData } }
    const project = fixtureProject({ id: 'server-project', name: 'Server project', directory: projectDir })
    const saved = await server.clients.call(a.id, 'save-projects', ['local', {
      baseRevision: revision,
      data: { ...data, projects: [...data.projects, project], projectOrder: [...(data.projectOrder ?? []), project.id] }
    }]) as { ok: boolean }
    expect(saved.ok).toBe(true)
    await a.waitFor(p => p.channel === 'projects-updated')

    expect(await server.clients.call(a.id, 'fb-read-file', [projectDir, 'hello.txt'])).toBe('hello from the server\n')
    await expect(server.clients.call(a.id, 'fb-read-file', [projectDir, '../outside.txt'])).rejects.toThrow()
    await expect(server.clients.call(a.id, 'fb-read-directory', ['/etc', ''])).rejects.toThrow()
  })

  it('keeps a desktop\'s slice of projects in its own data: its tags, order and pins stay, tag ids too', async () => {
    const { local: before } = await server.clients.call(a.id, 'load-projects') as { local: { revision: number; data: ProjectsData } }
    // A restart never reuses a revision: they start from the clock.
    expect(before.revision).toBeGreaterThan(1_600_000_000_000)
    // The server's own tag, on its own project (an unused tag would be pruned).
    const own = {
      ...before.data,
      projects: before.data.projects.map((p, i) => (i === 0 ? { ...p, tagIds: ['server-tag'] } : p)),
      tags: [{ id: 'server-tag', name: 'phone' }],
      projectOrder: [...before.data.projectOrder].reverse()
    }
    const first = await server.clients.call(a.id, 'save-projects', ['local', { baseRevision: before.revision, data: own }]) as { ok: boolean; revision: number }
    expect(first.ok).toBe(true)

    const added = { ...fixtureProject({ id: 'from-desktop', name: 'From a desktop', directory: projectDir }), tagIds: ['desktop-only-tag'], host: 'this-server' }
    const slice = { projects: [...own.projects, added] }
    const saved = await server.clients.call(a.id, 'save-projects-slice', [{ baseRevision: first.revision, data: slice }]) as { ok: boolean }
    expect(saved.ok).toBe(true)
    const { local: after } = await server.clients.call(a.id, 'load-projects') as { local: { revision: number; data: ProjectsData } }
    const stored = after.data.projects.find(p => p.id === 'from-desktop')!
    expect(stored.tagIds).toEqual(['desktop-only-tag'])
    expect(stored).not.toHaveProperty('host')
    expect(after.data.tags).toEqual([{ id: 'server-tag', name: 'phone' }])
    expect(after.data.projectOrder).toEqual([...own.projectOrder, 'from-desktop'])

    // A stale slice is refused with the server's data, as for a window.
    const stale = await server.clients.call(a.id, 'save-projects-slice', [{ baseRevision: first.revision, data: slice }]) as { ok: boolean; revision: number }
    expect(stale).toMatchObject({ ok: false, revision: after.revision })
  })

  it('works out a shell\'s status itself, with no window\'s help', async () => {
    const tabId = 'status-tab'
    await server.clients.call(a.id, 'pty-spawn', [tabId, '/bin/sh', projectDir, 80, 24, ['-c', 'echo busy; sleep 30'], {}, undefined, undefined])
    await ptyText(a, tabId, 'busy')
    await expect.poll(() => server.host.tabStatuses()[tabId]).toBe('working')
    await server.clients.call(a.id, 'pty-kill', [tabId])
  })

  it('lists its folders and finds its repos for a desktop adding a project', async () => {
    const listing = await server.clients.call(a.id, 'server-list-dirs', ['ignored-host-id', projectDir, {}]) as { path: string; entries: unknown[] }
    expect(listing.path).toBe(projectDir)
    fs.mkdirSync(path.join(projectDir, 'repo', '.git'), { recursive: true })
    const found = await server.clients.call(a.id, 'server-discover-repos', ['ignored-host-id', { root: projectDir }]) as { repos: Array<{ name: string }> }
    expect(found.repos.map(r => r.name)).toEqual(['repo'])
  })

  it('runs a chat tab against the configured claude', async () => {
    const fakeClaude = path.resolve('tests/helpers/fake-claude.mjs')
    await server.clients.call(a.id, 'save-config', [{ claudeCommand: fakeClaude }])
    expect(server.host.getConfig().claudeCommand).toBe(fakeClaude)

    const tabId = 'chat-tab-1'
    const snapshot = await server.clients.call(a.id, 'chat-attach', [tabId, { cwd: projectDir, sessionId: randomUUID() }]) as { seq: number }
    expect(snapshot.seq).toBeGreaterThanOrEqual(0)
    await server.clients.call(a.id, 'chat-send', [tabId, 'ping from the test', []])

    const isReply = (p: Push) => {
      if (p.channel !== 'chat-event' || p.args[0] !== tabId) return false
      const event = p.args[2] as { t?: string; m?: { type?: string; message?: { content?: { text?: string }[] } } }
      return event.t === 'sdk' && event.m?.type === 'assistant'
        && (event.m.message?.content ?? []).some(block => block.text === 'echo: ping from the test')
    }
    await a.waitFor(isReply, 20_000)
    await a.waitFor(p => p.channel === 'chat-event' && p.args[0] === tabId && (p.args[2] as { m?: { type?: string } }).m?.type === 'result')
    await server.clients.call(a.id, 'chat-close', [tabId])
  }, 30_000)

  it('shuts down like a quitting desktop: PTYs end and their scrollback is saved', async () => {
    const tabId = 'pty-tab-2'
    await server.clients.call(a.id, 'pty-spawn', [
      tabId, '/bin/sh', projectDir, 80, 24, ['-c', 'echo still-running; exec cat'], {}, undefined, undefined
    ])
    await ptyText(a, tabId, 'still-running')
    await server.shutdown()
    expect(fs.readFileSync(path.join(home, 'data/scrollback', `${tabId}.txt`), 'utf8')).toContain('still-running')
  })
})

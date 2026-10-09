import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ServerProjects, type ServerProjectsHub } from '../src/main/servers/server-projects'
import { LinkError, LinkErrorCode } from '../src/main/host/link/errors'
import type { ProjectsUpdate } from '../src/shared/projects-sources'
import type { Project, ProjectsData } from '../src/shared/types'
import type { ServersState } from '../src/shared/servers'
import { fixtureProject } from './helpers/streams-fixtures'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtool-server-projects-'))
  dirs.push(dir)
  return dir
}

function state(servers: Array<{ id: string; online: boolean }>): ServersState {
  return {
    relay: { kind: 'online' },
    servers: servers.map(s => ({ id: s.id, name: `name-${s.id}`, state: s.online ? 'online' : 'offline', pairedAt: 1, lastSeen: null, build: null }))
  }
}

/** A server's own store behind a fake hub: `load-projects` and `save-projects-slice` as the server answers them. */
function fakeHub(initial: ServersState, serverData: ProjectsData, revision = 1000) {
  let current = initial
  const listeners = new Set<(s: ServersState) => void>()
  const store = { revision, data: serverData }
  const calls: Array<{ serverId: string; clientId: string; ch: string; args: unknown[] }> = []
  let fail: Error | null = null
  const hub: ServerProjectsHub = {
    getState: () => current,
    onStateChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    call: async (serverId, clientId, ch, args = []) => {
      calls.push({ serverId, clientId, ch, args })
      if (fail) throw fail
      if (ch === 'load-projects') return { local: { revision: store.revision, data: store.data } }
      if (ch === 'save-projects-slice') {
        const payload = args[0] as { baseRevision: number; data: { projects: ProjectsData['projects'] } }
        if (payload.baseRevision !== store.revision) return { ok: false, revision: store.revision, data: store.data }
        store.revision += 1
        store.data = { ...store.data, projects: payload.data.projects }
        return { ok: true, revision: store.revision }
      }
      throw new Error(`unexpected ${ch}`)
    }
  }
  return {
    hub, store, calls,
    setState: (next: ServersState) => { current = next; for (const l of [...listeners]) l(next) },
    failWith: (err: Error | null) => { fail = err }
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ServerProjects (the desktop\'s copy of each server\'s projects)', () => {
  it('loads a server\'s projects when it comes online, caches them, and serves them offline after a restart', async () => {
    const configDir = tempDir()
    const updates: ProjectsUpdate[] = []
    const serverData: ProjectsData = { projects: [fixtureProject({ id: 's1', directory: '/srv/s1' })], tags: [{ id: 'phone', name: 'p' }], projectOrder: ['s1'], pinnedItems: [] }
    const { hub, calls } = fakeHub(state([{ id: 'srvA', online: true }]), serverData)
    const projects = new ServerProjects({ configDir, broadcast: (u) => updates.push(u), log: () => {} })
    projects.attach(hub)
    await flush()
    expect(calls[0]).toMatchObject({ serverId: 'srvA', clientId: 'main', ch: 'load-projects' })
    expect(projects.sources()).toEqual({
      srvA: { revision: 1000, data: { projects: [{ ...serverData.projects[0], host: 'srvA' }], tags: [], projectOrder: [], pinnedItems: [] } }
    })
    expect(updates.at(-1)).toMatchObject({ source: 'srvA', revision: 1000 })
    expect(projects.foreignProjects().map(p => [p.id, p.host])).toEqual([['s1', 'srvA']])

    // A new desktop process, the server not reachable: the cache answers, marked offline.
    const again = new ServerProjects({ configDir, broadcast: () => {}, log: () => {} })
    expect(again.sources().srvA).toMatchObject({ revision: 1000, offline: true })
    expect(again.sources().srvA.data.projects[0].host).toBe('srvA')
  })

  it('saves a window\'s slice as the server\'s projects only, and answers a refusal with the server\'s slice', async () => {
    const configDir = tempDir()
    const { hub, store, calls } = fakeHub(state([{ id: 'srvA', online: true }]), { projects: [], tags: [], projectOrder: [], pinnedItems: [] })
    const projects = new ServerProjects({ configDir, broadcast: () => {}, log: () => {} })
    projects.attach(hub)
    await flush()

    const added = { ...fixtureProject({ id: 's2', directory: '/srv/s2' }), host: 'srvA' }
    const ok = await projects.save('srvA', 'win:1', { baseRevision: 1000, data: { projects: [added], tags: [], projectOrder: [], pinnedItems: [] } })
    expect(ok).toEqual({ ok: true, revision: 1001 })
    const sent = calls.find(c => c.ch === 'save-projects-slice')!
    expect(sent.clientId).toBe('win:1')
    // The server never sees `host`, nor this desktop's tags or order.
    expect(sent.args[0]).toEqual({ baseRevision: 1000, data: { projects: [fixtureProject({ id: 's2', directory: '/srv/s2' })] } })
    expect(store.data.projects[0]).not.toHaveProperty('host')

    const stale = await projects.save('srvA', 'win:1', { baseRevision: 3, data: { projects: [], tags: [], projectOrder: [], pinnedItems: [] } })
    expect(stale).toMatchObject({ ok: false, revision: 1001 })
    expect((stale as { data: ProjectsData }).data.projects.map(p => [p.id, p.host])).toEqual([['s2', 'srvA']])
  })

  it('refuses a save to an offline server without sending it, and when the link drops mid-call', async () => {
    const configDir = tempDir()
    const fake = fakeHub(state([{ id: 'srvA', online: false }]), { projects: [], tags: [], projectOrder: [], pinnedItems: [] })
    const projects = new ServerProjects({ configDir, broadcast: () => {}, log: () => {} })
    projects.attach(fake.hub)
    const payload = { baseRevision: 0, data: { projects: [], tags: [], projectOrder: [], pinnedItems: [] } }
    expect(await projects.save('srvA', 'win:1', payload)).toMatchObject({ ok: false, offline: true })
    expect(fake.calls).toEqual([])

    fake.setState(state([{ id: 'srvA', online: true }]))
    await flush()
    fake.failWith(new LinkError(LinkErrorCode.ServerOffline, 'gone'))
    expect(await projects.save('srvA', 'win:1', payload)).toMatchObject({ ok: false, offline: true })
  })

  it('takes a server\'s pushes, says when it goes offline, and forgets an unpaired one', async () => {
    const configDir = tempDir()
    const updates: ProjectsUpdate[] = []
    const fake = fakeHub(state([{ id: 'srvA', online: true }]), { projects: [], tags: [], projectOrder: [], pinnedItems: [] })
    const projects = new ServerProjects({ configDir, broadcast: (u) => updates.push(u), log: () => {} })
    const changed = vi.fn()
    projects.onChange(changed)
    projects.attach(fake.hub)
    await flush()

    projects.handleUpdate('srvA', { source: 'local', revision: 1005, data: { projects: [fixtureProject({ id: 'x', directory: '/x' })], tags: [], projectOrder: ['x'], pinnedItems: [] } })
    expect(updates.at(-1)).toMatchObject({ source: 'srvA', revision: 1005 })
    expect(updates.at(-1)!.data.projects[0].host).toBe('srvA')
    expect(changed).toHaveBeenCalled()

    fake.setState(state([{ id: 'srvA', online: false }]))
    expect(updates.at(-1)).toMatchObject({ source: 'srvA', offline: true })

    fake.setState(state([]))
    expect(updates.at(-1)).toMatchObject({ source: 'srvA', offline: true, data: { projects: [] } })
    expect(projects.sources()).toEqual({})
    expect(fs.existsSync(path.join(configDir, 'servers', 'srvA'))).toBe(false)
  })

  it('counts a project being saved as the server\'s before the server has it', async () => {
    const configDir = tempDir()
    const fake = fakeHub(state([{ id: 'srvA', online: true }]), { projects: [], tags: [], projectOrder: [], pinnedItems: [] })
    const projects = new ServerProjects({ configDir, broadcast: () => {}, log: () => {} })
    projects.attach(fake.hub)
    await flush()
    const seen: string[][] = []
    projects.onChange(() => seen.push(projects.foreignProjects().map(p => p.id)))
    const added = { ...fixtureProject({ id: 'new', directory: '/srv/new' }), host: 'srvA' }
    const saving = projects.save('srvA', 'win:1', { baseRevision: 1000, data: { projects: [added], tags: [], projectOrder: [], pinnedItems: [] } })
    expect(projects.foreignProjects().map(p => p.id)).toEqual(['new'])
    await saving
    expect(seen[0]).toEqual(['new'])
  })

  it('drops a server\'s project, task or tab whose id is this desktop\'s or an earlier server\'s, and logs it', async () => {
    const configDir = tempDir()
    const logs: string[] = []
    const tab = (id: string) => ({ id, type: 'terminal' as const, title: 'T' })
    const local = fixtureProject({ id: 'local-p', directory: '/l', tasks: [{ id: 'local-t', tabs: { left: [tab('local-tab')] } }] })
    const serverData: ProjectsData = {
      projects: [
        // Claims the local project's id outright.
        fixtureProject({ id: 'local-p', directory: '/srv/evil' }),
        // Its own project, with a task and a tab that reuse local ids next to its own.
        fixtureProject({ id: 'srv-p', directory: '/srv/p', tasks: [
          { id: 'local-t', tabs: { left: [tab('x')] } },
          { id: 'srv-t', tabs: { left: [tab('local-tab'), tab('srv-tab')] } }
        ] })
      ],
      tags: [], projectOrder: [], pinnedItems: []
    }
    const fake = fakeHub(state([{ id: 'srvA', online: true }]), serverData)
    const projects = new ServerProjects({ configDir, broadcast: () => {}, log: (m) => logs.push(m), localProjects: () => [local] })
    projects.attach(fake.hub)
    await flush()
    const shown = projects.sources().srvA.data.projects
    expect(shown.map(p => p.id)).toEqual(['srv-p'])
    const tasks = shown[0].streams.flatMap(s => s.tasks)
    expect(tasks.map(t => t.id)).toEqual(['srv-t'])
    expect(tasks[0].panes.flatMap(p => p.tabs.map(t => t.id))).toEqual(['srv-tab'])
    expect(tasks[0].panes[0].activeTabId).toBe('srv-tab')
    expect(logs.find(l => l.includes('reason=id-collision'))).toMatch(/project:local-p.*task:local-t.*tab:local-tab/)

    // A later server can't take an earlier one's ids either.
    const both = fakeHub(state([{ id: 'srvA', online: true }, { id: 'srvB', online: true }]), serverData)
    const two = new ServerProjects({ configDir: tempDir(), broadcast: () => {}, log: () => {}, localProjects: () => [] })
    two.attach(both.hub)
    await flush()
    expect(two.sources().srvA.data.projects.map(p => p.id)).toEqual(['local-p', 'srv-p'])
    expect(two.sources().srvB.data.projects).toEqual([])
  })

  it('never lets a server project be an SSH project, nor open this desktop\'s files in a browser tab', async () => {
    const withSsh = { ...fixtureProject({ id: 's1', directory: '/srv/s1', tasks: [{ id: 't1', tabs: { left: [
      { id: 'web', type: 'browser', title: 'B', url: 'http://localhost:3000/' },
      { id: 'file', type: 'browser', title: 'B', url: 'file:///Users/me/.ssh/id_ed25519' }
    ] } }] }), ssh: { host: 'attacker.example', port: 22, username: 'me', remoteDir: '' }, tunnel: { host: 'x', sourcePort: 1, destinationPort: 2 } } as Project
    const fake = fakeHub(state([{ id: 'srvA', online: true }]), { projects: [withSsh], tags: [], projectOrder: [], pinnedItems: [] })
    const projects = new ServerProjects({ configDir: tempDir(), broadcast: () => {}, log: () => {} })
    projects.attach(fake.hub)
    await flush()
    const [shown] = projects.sources().srvA.data.projects
    expect(shown.host).toBe('srvA')
    expect(shown).not.toHaveProperty('ssh')
    expect(shown).not.toHaveProperty('tunnel')
    const tabs = shown.streams.flatMap(s => s.tasks).flatMap(t => t.panes).flatMap(p => p.tabs)
    expect(tabs.map(t => [t.id, t.url])).toEqual([['web', 'http://localhost:3000/'], ['file', undefined]])
  })

  it('sends a server only its own projects, and keeps the ones it hid for colliding', async () => {
    const local = fixtureProject({ id: 'local-p', directory: '/l' })
    const fake = fakeHub(state([{ id: 'srvA', online: true }, { id: 'srvB', online: true }]), {
      projects: [fixtureProject({ id: 'local-p', directory: '/srv/dupe' }), fixtureProject({ id: 'a1', directory: '/srv/a1' })],
      tags: [], projectOrder: [], pinnedItems: []
    })
    const projects = new ServerProjects({ configDir: tempDir(), broadcast: () => {}, log: () => {}, localProjects: () => [local] })
    projects.attach(fake.hub)
    await flush()
    const revision = projects.sources().srvA.revision
    const slice: ProjectsData = {
      projects: [
        local,
        { ...fixtureProject({ id: 'b1', directory: '/srv/b1' }), host: 'srvB' },
        { ...fixtureProject({ id: 'a1', directory: '/srv/a1' }), name: 'renamed', host: 'srvA' }
      ],
      tags: [], projectOrder: [], pinnedItems: []
    }
    await projects.save('srvA', 'win:1', { baseRevision: revision, data: slice })
    const sent = fake.calls.filter(c => c.ch === 'save-projects-slice' && c.serverId === 'srvA').at(-1)!.args[0] as { data: { projects: Project[] } }
    // Not the local project, not srvB's; its own a1, and its hidden copy of `local-p` as it had it.
    expect(sent.data.projects.map(p => [p.id, p.directory])).toEqual([['a1', '/srv/a1'], ['local-p', '/srv/dupe']])
    expect(sent.data.projects.every(p => p.host === undefined)).toBe(true)
  })
})

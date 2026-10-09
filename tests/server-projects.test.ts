import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ServerProjects, type ServerProjectsHub } from '../src/main/servers/server-projects'
import { LinkError, LinkErrorCode } from '../src/main/host/link/errors'
import type { ProjectsUpdate } from '../src/shared/projects-sources'
import type { ProjectsData } from '../src/shared/types'
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
})

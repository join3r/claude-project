import { describe, expect, it } from 'vitest'
import { ProjectsSync } from '../src/renderer/hooks/projectsSync'
import { LOCAL_SOURCE, sliceOf, withSlice, type SourceSaveResult } from '../src/shared/projects-sources'
import type { Project, ProjectsData } from '../src/shared/types'
import { appendProject } from '../src/renderer/hooks/appState/projectsData'
import { fixtureProject } from './helpers/streams-fixtures'

/**
 * The renderer's per-source compare-and-swap (plan step 0 note 3): one
 * RevisionSyncClient per source, a mutation recorded on each source whose slice
 * it changes, and a refusal from one source replaying only that source's slice.
 */

interface Store {
  revision: number
  data: ProjectsData
  /** Answer the next save with a refusal, as if someone else wrote first. */
  refuseNext?: ProjectsData
  offline?: boolean
}

function harness(initial: ProjectsData, stores: Record<string, Store>) {
  let data = initial
  const saves: Array<{ source: string; baseRevision: number; data: ProjectsData }> = []
  const errors: string[] = []
  const offline: string[] = []
  const sync = new ProjectsSync({
    save: async (source, payload): Promise<SourceSaveResult> => {
      saves.push({ source, ...payload })
      const store = stores[source]
      if (store.offline) return { ok: false, offline: true, revision: store.revision, data: store.data }
      if (store.refuseNext) {
        store.data = store.refuseNext
        store.revision += 1
        store.refuseNext = undefined
        return { ok: false, revision: store.revision, data: store.data }
      }
      if (payload.baseRevision !== store.revision) return { ok: false, revision: store.revision, data: store.data }
      store.revision += 1
      store.data = payload.data
      return { ok: true, revision: store.revision }
    },
    getData: () => data,
    apply: (change) => { data = change(data) },
    onError: (message) => errors.push(message),
    onOffline: (source) => offline.push(source)
  })
  const mutate = (updater: (prev: ProjectsData) => ProjectsData): boolean => {
    const { refused } = sync.record(updater)
    if (refused) return false
    data = updater(data)
    sync.saveChanged(data)
    return true
  }
  return {
    sync, saves, errors, offline, mutate,
    get data() { return data },
    setData: (next: ProjectsData) => { data = next }
  }
}

const serverProject = (id: string, host = 'srv1'): Project => ({ ...fixtureProject({ id, directory: `/srv/${id}` }), host })
const empty = (): ProjectsData => ({ projects: [], tags: [], projectOrder: [], pinnedItems: [] })

function loaded(localProjects: Project[], serverProjects: Project[]) {
  const stores: Record<string, Store> = {
    [LOCAL_SOURCE]: { revision: 5, data: { projects: localProjects, tags: [], projectOrder: localProjects.map(p => p.id), pinnedItems: [] } },
    srv1: { revision: 900, data: { ...empty(), projects: serverProjects.map(p => ({ ...p, host: undefined })) } }
  }
  const h = harness(empty(), stores)
  const start = h.sync.hydrate({
    [LOCAL_SOURCE]: { revision: stores[LOCAL_SOURCE].revision, data: stores[LOCAL_SOURCE].data },
    srv1: { revision: stores.srv1.revision, data: { ...empty(), projects: serverProjects } }
  })
  h.sync.markSaved(start)
  h.setData(start)
  return { h, stores }
}

describe('ProjectsSync (one compare-and-swap per source)', () => {
  it('merges the loaded sources, server projects listed after the local order', () => {
    const { h } = loaded([fixtureProject({ id: 'l1', directory: '/l1' })], [serverProject('s1')])
    expect(h.data.projects.map(p => [p.id, p.host])).toEqual([['l1', undefined], ['s1', 'srv1']])
    expect(h.data.projectOrder).toEqual(['l1', 's1'])
  })

  it('adding a server project saves its slice to the server and the order to this desktop, once each', async () => {
    const { h, stores } = loaded([fixtureProject({ id: 'l1', directory: '/l1' })], [])
    // The append is not idempotent: replaying it twice on one store would list the project twice.
    h.mutate(prev => appendProject(prev, serverProject('s2')))
    await h.sync.settled()
    expect(h.saves.map(s => s.source).sort()).toEqual([LOCAL_SOURCE, 'srv1'])
    expect(stores.srv1.data.projects.map(p => p.id)).toEqual(['s2'])
    expect(stores[LOCAL_SOURCE].data.projects.map(p => p.id)).toEqual(['l1'])
    expect(stores[LOCAL_SOURCE].data.projectOrder).toEqual(['l1', 's2'])
    // The server's save went first, so main knows the project before the order names it.
    expect(h.saves[0].source).toBe('srv1')
  })

  it('a refusal from one server replays only that server\'s slice', async () => {
    const { h, stores } = loaded([fixtureProject({ id: 'l1', directory: '/l1' })], [serverProject('s1')])
    // Another desktop renamed s1 on the server meanwhile.
    stores.srv1.refuseNext = { ...empty(), projects: [{ ...fixtureProject({ id: 's1', directory: '/srv/s1' }), name: 'theirs' }] }
    h.mutate(prev => appendProject(prev, serverProject('s2')))
    await h.sync.settled()
    // Local landed once; the server's slice was replayed onto its canonical data.
    expect(h.saves.filter(s => s.source === LOCAL_SOURCE)).toHaveLength(1)
    expect(h.saves.filter(s => s.source === 'srv1')).toHaveLength(2)
    expect(stores.srv1.data.projects.map(p => [p.id, p.name])).toEqual([['s1', 'theirs'], ['s2', 's2']])
    expect(stores[LOCAL_SOURCE].data.projectOrder).toEqual(['l1', 's1', 's2'])
    // The window shows the server's canonical name plus its own add, nothing twice.
    expect(h.data.projects.filter(p => p.host === 'srv1').map(p => [p.id, p.name])).toEqual([['s1', 'theirs'], ['s2', 's2']])
    expect(h.errors).toEqual([])
  })

  it('refuses a change to an offline server\'s projects before anything is sent', async () => {
    const { h } = loaded([], [serverProject('s1')])
    h.sync.receive({ source: 'srv1', revision: 900, data: { ...empty(), projects: [serverProject('s1')] }, offline: true })
    expect(h.sync.isOffline('srv1')).toBe(true)
    const before = h.data
    expect(h.mutate(prev => ({ ...prev, projects: prev.projects.map(p => ({ ...p, name: 'edited' })) }))).toBe(false)
    expect(h.data).toBe(before)
    await h.sync.settled()
    expect(h.saves).toEqual([])
    // Local changes still go through.
    expect(h.mutate(prev => appendProject(prev, fixtureProject({ id: 'l9', directory: '/l9' })))).toBe(true)
  })

  it('a server that went offline mid-save rolls its slice back and says so', async () => {
    const { h, stores } = loaded([], [serverProject('s1')])
    stores.srv1.offline = true
    h.mutate(prev => ({ ...prev, projects: prev.projects.map(p => ({ ...p, name: 'edited' })) }))
    await h.sync.settled()
    expect(h.offline).toEqual(['srv1'])
    expect(h.errors).toEqual([])
    expect(h.data.projects.find(p => p.id === 's1')!.name).toBe('s1')
    expect(h.sync.isOffline('srv1')).toBe(true)
  })

  it('a broadcast from one source keeps another source\'s unsaved change', async () => {
    const { h, stores } = loaded([fixtureProject({ id: 'l1', directory: '/l1' })], [serverProject('s1')])
    // Hold the server's save in flight while the local store broadcasts.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const save = (h.sync as unknown as { options: { save: (s: string, p: unknown) => Promise<SourceSaveResult> } }).options
    const original = save.save
    save.save = async (source, payload) => {
      if (source === 'srv1') await gate
      return original(source, payload)
    }
    h.mutate(prev => ({ ...prev, projects: prev.projects.map(p => (p.id === 's1' ? { ...p, name: 'mine' } : p)) }))
    const localNext = { ...stores[LOCAL_SOURCE].data, projects: [{ ...stores[LOCAL_SOURCE].data.projects[0], name: 'from another window' }] }
    h.sync.receive({ source: LOCAL_SOURCE, revision: 6, data: localNext })
    expect(h.data.projects.find(p => p.id === 'l1')!.name).toBe('from another window')
    expect(h.data.projects.find(p => p.id === 's1')!.name).toBe('mine')
    release()
    await h.sync.settled()
    expect(stores.srv1.data.projects[0].name).toBe('mine')
  })

  it('slices replay against the window\'s current other sources', () => {
    const data: ProjectsData = { projects: [serverProject('s1')], tags: [], projectOrder: ['s1'], pinnedItems: [] }
    const slice = sliceOf(data, 'srv1')
    expect(withSlice(data, 'srv1', slice)).toEqual(data)
  })
})

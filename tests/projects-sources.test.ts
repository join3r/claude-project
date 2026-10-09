import { describe, expect, it } from 'vitest'
import {
  LOCAL_SOURCE,
  changedSources,
  mergeProjectsSlice,
  mergeSources,
  orderServerProjects,
  projectsSourceOf,
  sliceOf,
  sourcesIn,
  withSlice
} from '../src/shared/projects-sources'
import { pruneUnusedTags, type ProjectsData } from '../src/shared/types'
import { Storage } from '../src/main/storage'
import { allowedLocalRoots } from '../src/main/ipc/path-allowlist'
import { fixtureProject } from './helpers/streams-fixtures'

const local = fixtureProject({ id: 'l1', directory: '/home/me/local', tagIds: ['t-mine'] })
const onA = { ...fixtureProject({ id: 'a1', directory: '/srv/a1', tagIds: ['t-mine', 't-other-desktop'] }), host: 'srvA' }
const onB = { ...fixtureProject({ id: 'b1', directory: '/srv/b1' }), host: 'srvB' }

function merged(): ProjectsData {
  return {
    projects: [local, onA, onB],
    tags: [{ id: 't-mine', name: 'mine' }],
    projectOrder: ['a1', 'l1', 'b1'],
    pinnedItems: [{ type: 'project', projectId: 'a1' }]
  }
}

describe('projects sources', () => {
  it('slices the merged data per source: local keeps tags, order and pins; a server only its projects', () => {
    const data = merged()
    expect(projectsSourceOf(local)).toBe(LOCAL_SOURCE)
    expect(projectsSourceOf(onA)).toBe('srvA')
    expect(sourcesIn(data)).toEqual([LOCAL_SOURCE, 'srvA', 'srvB'])
    expect(sliceOf(data, LOCAL_SOURCE)).toEqual({
      projects: [local],
      tags: data.tags,
      projectOrder: ['a1', 'l1', 'b1'],
      pinnedItems: data.pinnedItems
    })
    expect(sliceOf(data, 'srvA')).toEqual({ projects: [onA], tags: [], projectOrder: [], pinnedItems: [] })
  })

  it('puts a slice back in place, giving a server slice its host', () => {
    const data = merged()
    const renamed = { ...onA, name: 'renamed' }
    const { host: _host, ...bare } = renamed
    const next = withSlice(data, 'srvA', { projects: [bare], tags: [], projectOrder: [], pinnedItems: [] })
    expect(next.projects.find(p => p.id === 'a1')).toEqual(renamed)
    expect(next.projects.filter(p => p.host === 'srvB')).toEqual([onB])
    expect(next.projectOrder).toEqual(data.projectOrder)

    const localNext = withSlice(data, LOCAL_SOURCE, { projects: [], tags: [], projectOrder: ['b1'], pinnedItems: [] })
    expect(localNext.projects.map(p => p.id)).toEqual(['a1', 'b1'])
    expect(localNext.projectOrder).toEqual(['b1'])
  })

  it('tells which sources a change touched', () => {
    const data = merged()
    const added = { ...fixtureProject({ id: 'a2', directory: '/srv/a2' }), host: 'srvA' }
    const next = { ...data, projects: [...data.projects, added], projectOrder: [...data.projectOrder, 'a2'] }
    expect(changedSources(data, next).sort()).toEqual([LOCAL_SOURCE, 'srvA'])
    expect(changedSources(data, { ...data, projects: data.projects.map(p => p.id === 'b1' ? { ...p, name: 'x' } : p) })).toEqual(['srvB'])
  })

  it('lists server projects the local order lacks at the end', () => {
    const data = { ...merged(), projectOrder: ['l1'] }
    expect(orderServerProjects(data).projectOrder).toEqual(['l1', 'a1', 'b1'])
    expect(mergeSources({
      [LOCAL_SOURCE]: { projects: [local], tags: [], projectOrder: ['l1'], pinnedItems: [] },
      srvA: { projects: [{ ...onA, host: undefined }], tags: [], projectOrder: [], pinnedItems: [] }
    }).projectOrder).toEqual(['l1', 'a1'])
  })

  it('merges a desktop slice into a server data without its own tags, order or pins going', () => {
    const server: ProjectsData = {
      projects: [{ ...onA, host: undefined }],
      tags: [{ id: 'phone-tag', name: 'phone' }],
      projectOrder: ['a1'],
      pinnedItems: [{ type: 'project', projectId: 'a1' }]
    }
    const added = fixtureProject({ id: 'a2', directory: '/srv/a2' })
    const next = Storage.normalizeProjectsData(
      mergeProjectsSlice(server, [onA, { ...added, host: 'srvA' }]) as unknown as Record<string, unknown>,
      { keepUnknownTagIds: true }
    )
    expect(next.projects.map(p => p.id)).toEqual(['a1', 'a2'])
    expect(next.projects.every(p => p.host === undefined)).toBe(true)
    expect(next.projectOrder).toEqual(['a1', 'a2'])
    expect(next.pinnedItems).toEqual(server.pinnedItems)
    // A server keeps tag ids only its desktops know.
    expect(next.projects[0].tagIds).toEqual(['t-mine', 't-other-desktop'])
  })
})

describe('tags and server projects', () => {
  it('pruneUnusedTags leaves a server project\'s tag ids alone and counts them as used', () => {
    const pruned = pruneUnusedTags(merged())
    expect(pruned.projects.find(p => p.id === 'a1')!.tagIds).toEqual(['t-mine', 't-other-desktop'])
    expect(pruned.tags).toEqual([{ id: 't-mine', name: 'mine' }])
    // A local project's unknown ids still go.
    const withStray = { ...merged(), projects: [{ ...local, tagIds: ['t-mine', 'gone'] }, onA] }
    expect(pruneUnusedTags(withStray).projects[0].tagIds).toEqual(['t-mine'])
  })

  it('a desktop\'s local store keeps the order, pins and tags its server projects need', () => {
    const localSlice = sliceOf(merged(), LOCAL_SOURCE)
    const foreign = [onA, onB]
    const kept = Storage.normalizeProjectsData(localSlice as unknown as Record<string, unknown>, { foreignProjects: foreign })
    expect(kept.projectOrder).toEqual(['a1', 'l1', 'b1'])
    expect(kept.pinnedItems).toEqual([{ type: 'project', projectId: 'a1' }])
    expect(kept.tags).toEqual([{ id: 't-mine', name: 'mine' }])
    // Without them (an unknown server), its entries go as before.
    const plain = Storage.normalizeProjectsData(localSlice as unknown as Record<string, unknown>)
    expect(plain.projectOrder).toEqual(['l1'])
    expect(plain.pinnedItems).toEqual([])
  })

  it('a tag only a server project uses stays in the local store', () => {
    const localSlice = { projects: [{ ...local, tagIds: [] }], tags: [{ id: 't-mine', name: 'mine' }], projectOrder: ['l1'], pinnedItems: [] }
    expect(Storage.normalizeProjectsData(localSlice as unknown as Record<string, unknown>, { foreignProjects: [onA] }).tags)
      .toEqual([{ id: 't-mine', name: 'mine' }])
    expect(Storage.normalizeProjectsData(localSlice as unknown as Record<string, unknown>).tags).toEqual([])
  })
})

describe('path allow-list on a desktop', () => {
  it('never allows a server project\'s directory as a local root', () => {
    expect(allowedLocalRoots([local, onA, onB])).toEqual(['/home/me/local'])
  })
})

import { describe, expect, it } from 'vitest'
import { setPinInData } from '../src/main/mobile/pin'
import { mainStreamId, type Project, type ProjectsData } from '../src/shared/types'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

function project(id: string, extra: Partial<Project> = {}): Project {
  return fixtureProject({
    id,
    directory: `/src/${id}`,
    tasks: [{ id: `${id}-t1` }],
    // A stream of two tasks.
    streams: [{ id: `${id}-s`, name: 'bugfixes', tasks: [fixtureTask({ id: `${id}-s1` }), fixtureTask({ id: `${id}-s2` })] }],
    ...extra
  })
}

function data(pinnedItems: ProjectsData['pinnedItems'] = []): ProjectsData {
  const projects = [project('p1'), project('hidden', { hideFromMobile: true })]
  return { projects, tags: [], projectOrder: projects.map(p => p.id), pinnedItems }
}

describe('setPinInData (SPEC.md §8.10)', () => {
  it('appends a new pin and removes an existing one', () => {
    const start = data([{ type: 'project', projectId: 'p1' }])
    const pinned = setPinInData(start, { projectId: 'p1', taskId: 'p1-t1', pinned: true })
    expect(pinned).toMatchObject({ ok: true, changed: true })
    if (!pinned.ok) return
    const taskPin = { type: 'task', projectId: 'p1', streamId: mainStreamId('p1'), taskId: 'p1-t1' }
    expect(pinned.data.pinnedItems).toEqual([{ type: 'project', projectId: 'p1' }, taskPin])
    const unpinned = setPinInData(pinned.data, { projectId: 'p1', pinned: false })
    expect(unpinned).toMatchObject({ ok: true, changed: true })
    if (!unpinned.ok) return
    expect(unpinned.data.pinnedItems).toEqual([taskPin])
  })

  it('leaves the data alone when the pin is already as asked', () => {
    const start = data([{ type: 'project', projectId: 'p1' }])
    expect(setPinInData(start, { projectId: 'p1', pinned: true })).toEqual({ ok: true, data: start, changed: false })
    expect(setPinInData(start, { projectId: 'p1', taskId: 'p1-t1', pinned: false })).toEqual({ ok: true, data: start, changed: false })
  })

  it('answers not-found for what the phone cannot see', () => {
    const start = data()
    expect(setPinInData(start, { projectId: 'nope', pinned: true })).toMatchObject({ ok: false, code: 'not-found' })
    expect(setPinInData(start, { projectId: 'hidden', pinned: true })).toMatchObject({ ok: false, code: 'not-found' })
    expect(setPinInData(start, { projectId: 'p1', taskId: 'nope', pinned: true })).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('pins a task of a stream with its stream id', () => {
    const result = setPinInData(data(), { projectId: 'p1', taskId: 'p1-s2', pinned: true })
    if (!result.ok) throw new Error(result.code)
    expect(result.data.pinnedItems).toEqual([{ type: 'task', projectId: 'p1', streamId: 'p1-s', taskId: 'p1-s2' }])
  })

  it('pins and unpins a stream, separately from its tasks', () => {
    const taskPin = { type: 'task', projectId: 'p1', streamId: 'p1-s', taskId: 'p1-s1' } as const
    const start = data([taskPin])
    const pinned = setPinInData(start, { projectId: 'p1', streamId: 'p1-s', pinned: true })
    if (!pinned.ok) throw new Error(pinned.code)
    expect(pinned.data.pinnedItems).toEqual([taskPin, { type: 'stream', projectId: 'p1', streamId: 'p1-s' }])
    // A task of a pinned stream is not pinned by itself.
    expect(setPinInData(pinned.data, { projectId: 'p1', taskId: 'p1-s2', pinned: false })).toMatchObject({ ok: true, changed: false })
    const unpinned = setPinInData(pinned.data, { projectId: 'p1', streamId: 'p1-s', pinned: false })
    if (!unpinned.ok) throw new Error(unpinned.code)
    expect(unpinned.data.pinnedItems).toEqual([taskPin])
    expect(setPinInData(start, { projectId: 'p1', streamId: 'gone', pinned: true })).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('takes the task over the stream when both are named', () => {
    const result = setPinInData(data(), { projectId: 'p1', streamId: 'wrong', taskId: 'p1-s2', pinned: true })
    if (!result.ok) throw new Error(result.code)
    expect(result.data.pinnedItems).toEqual([{ type: 'task', projectId: 'p1', streamId: 'p1-s', taskId: 'p1-s2' }])
  })
})

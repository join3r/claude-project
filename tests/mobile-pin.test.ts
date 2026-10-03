import { describe, expect, it } from 'vitest'
import { setPinInData } from '../src/main/mobile/pin'
import { createHomeTask, type Project, type ProjectsData, type Task } from '../src/shared/types'

function task(id: string): Task {
  return { id, name: id, tabs: { left: [], right: [] }, activeTab: { left: null, right: null }, splitOpen: false, splitRatio: 0.5 }
}

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, directory: `/src/${id}`, tasks: [createHomeTask(id).task, task(`${id}-t1`)], ...extra }
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
    expect(pinned.data.pinnedItems).toEqual([{ type: 'project', projectId: 'p1' }, { type: 'task', projectId: 'p1', taskId: 'p1-t1' }])
    const unpinned = setPinInData(pinned.data, { projectId: 'p1', pinned: false })
    expect(unpinned).toMatchObject({ ok: true, changed: true })
    if (!unpinned.ok) return
    expect(unpinned.data.pinnedItems).toEqual([{ type: 'task', projectId: 'p1', taskId: 'p1-t1' }])
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
    const home = start.projects[0].tasks[0].id
    expect(setPinInData(start, { projectId: 'p1', taskId: home, pinned: true })).toMatchObject({ ok: false, code: 'not-found' })
  })
})

import { describe, it, expect } from 'vitest'
import { mainStreamId, normalizePinnedItems, pinnedItemKey, type Project } from '../src/shared/types'
import { Storage } from '../src/main/storage'
import { fixtureProject } from './helpers/streams-fixtures'

function project(id: string, taskIds: string[] = []): Project {
  return fixtureProject({ id, tasks: taskIds.map(taskId => ({ id: taskId })) })
}

describe('normalizePinnedItems', () => {
  const projects = [project('p1', ['t1', 't2']), project('p2')]

  it('keeps valid project, stream and task pins in order', () => {
    const items = [
      { type: 'task', projectId: 'p1', streamId: mainStreamId('p1'), taskId: 't2' },
      { type: 'stream', projectId: 'p1', streamId: mainStreamId('p1') },
      { type: 'project', projectId: 'p2' }
    ]
    expect(normalizePinnedItems(items, projects)).toEqual(items)
  })

  it('rewrites a task pin to the stream that holds the task now', () => {
    expect(normalizePinnedItems([
      { type: 'task', projectId: 'p1', streamId: 'old-stream', taskId: 't1' }
    ], projects)).toEqual([{ type: 'task', projectId: 'p1', streamId: mainStreamId('p1'), taskId: 't1' }])
  })

  it('drops pins for missing projects and tasks', () => {
    expect(normalizePinnedItems([
      { type: 'project', projectId: 'gone' },
      { type: 'task', projectId: 'p1', taskId: 'gone' },
      { type: 'task', projectId: 'gone', taskId: 't1' },
      { type: 'stream', projectId: 'p1', streamId: 'gone' }
    ], projects)).toEqual([])
  })

  it('dedupes by pin key', () => {
    expect(normalizePinnedItems([
      { type: 'project', projectId: 'p1' },
      { type: 'project', projectId: 'p1' }
    ], projects)).toEqual([{ type: 'project', projectId: 'p1' }])
  })

  it('tolerates garbage input', () => {
    expect(normalizePinnedItems('nope', projects)).toEqual([])
    expect(normalizePinnedItems([null, 42, {}, { type: 'task', projectId: 'p1' }], projects)).toEqual([])
  })

  it('produces distinct keys for project vs task pins', () => {
    expect(pinnedItemKey({ type: 'project', projectId: 'p1' }))
      .not.toBe(pinnedItemKey({ type: 'task', projectId: 'p1', streamId: mainStreamId('p1'), taskId: 't1' }))
    expect(pinnedItemKey({ type: 'stream', projectId: 'p1', streamId: 't1' }))
      .not.toBe(pinnedItemKey({ type: 'task', projectId: 'p1', streamId: 't1', taskId: 't1' }))
  })
})

describe('Storage.normalizeProjectsData pinnedItems', () => {
  it('defaults pinnedItems to [] on legacy data without the field', () => {
    const data = Storage.normalizeProjectsData({ projects: [project('p1')] } as unknown as Record<string, unknown>)
    expect(data.pinnedItems).toEqual([])
  })

  it('drops dangling pins on load', () => {
    const data = Storage.normalizeProjectsData({
      projects: [project('p1', ['t1'])],
      pinnedItems: [
        { type: 'task', projectId: 'p1', streamId: mainStreamId('p1'), taskId: 't1' },
        { type: 'project', projectId: 'deleted' }
      ]
    } as unknown as Record<string, unknown>)
    expect(data.pinnedItems).toEqual([{ type: 'task', projectId: 'p1', streamId: mainStreamId('p1'), taskId: 't1' }])
  })
})

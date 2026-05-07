import { describe, it, expect } from 'vitest'
import { backfillLifetimeStats, incrementLifetimeStat } from '../src/renderer/hooks/lifetimeStats'
import type { Project } from '../src/shared/types'

function makeProject(id: string, taskCount: number, lifetime?: { tasksCreated: number; notesCreated: number }): Project {
  return {
    id,
    name: id,
    directory: `/tmp/${id}`,
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      id: `${id}-t${i}`,
      name: `t${i}`,
      tabs: { left: [], right: [] },
      activeTab: { left: null, right: null },
      splitOpen: false,
      splitRatio: 0.5
    })),
    lifetimeStats: lifetime
  }
}

describe('backfillLifetimeStats', () => {
  it('initializes lifetimeStats from current counts when missing', () => {
    const project = makeProject('p1', 3)
    const notes = { p1: [{ id: 'n1', name: 'n', content: '', createdAt: 0, updatedAt: 0 }] }
    const filled = backfillLifetimeStats(project, notes)
    expect(filled.lifetimeStats).toEqual({ tasksCreated: 3, notesCreated: 1 })
  })
  it('leaves existing lifetimeStats alone', () => {
    const project = makeProject('p1', 3, { tasksCreated: 99, notesCreated: 42 })
    const filled = backfillLifetimeStats(project, { p1: [] })
    expect(filled.lifetimeStats).toEqual({ tasksCreated: 99, notesCreated: 42 })
  })
  it('returns same reference if no change needed (existing stats)', () => {
    const project = makeProject('p1', 3, { tasksCreated: 99, notesCreated: 42 })
    const filled = backfillLifetimeStats(project, { p1: [] })
    expect(filled).toBe(project)
  })
})

describe('incrementLifetimeStat', () => {
  it('bumps tasksCreated', () => {
    const project = makeProject('p1', 0, { tasksCreated: 5, notesCreated: 5 })
    const next = incrementLifetimeStat(project, 'tasksCreated')
    expect(next.lifetimeStats).toEqual({ tasksCreated: 6, notesCreated: 5 })
  })
  it('bumps notesCreated', () => {
    const project = makeProject('p1', 0, { tasksCreated: 5, notesCreated: 5 })
    const next = incrementLifetimeStat(project, 'notesCreated')
    expect(next.lifetimeStats).toEqual({ tasksCreated: 5, notesCreated: 6 })
  })
  it('initializes the field if missing then increments', () => {
    const project = makeProject('p1', 2)
    const next = incrementLifetimeStat(project, 'tasksCreated')
    expect(next.lifetimeStats).toEqual({ tasksCreated: 1, notesCreated: 0 })
  })
})

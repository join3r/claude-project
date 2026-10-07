import { describe, expect, it } from 'vitest'
import { triageTaskInData } from '../src/main/mobile/triage'
import { type Project, type ProjectsData, type TaskInboxState } from '../src/shared/types'
import { findTaskInProject } from '../src/shared/streams'
import { fixtureProject, type FixtureTask } from './helpers/streams-fixtures'

const NOW = 1_790_000_000_000

function task(id: string, inbox?: TaskInboxState): FixtureTask {
  return { id, inbox }
}

function project(id: string, tasks: FixtureTask[], extra: Partial<Project> = {}): Project {
  return fixtureProject({ id, directory: `/src/${id}`, tasks, ...extra })
}

function data(inbox?: TaskInboxState): ProjectsData {
  const projects = [project('p1', [task('t1', inbox), task('t2')]), project('hidden', [task('h1')], { hideFromMobile: true })]
  return { projects, tags: [], projectOrder: projects.map(p => p.id), pinnedItems: [] }
}

function inboxOf(result: ReturnType<typeof triageTaskInData>): TaskInboxState | undefined {
  if (!result.ok) throw new Error(result.code)
  return findTaskInProject(result.data.projects[0], 't1')?.inbox
}

describe('triageTaskInData (SPEC.md §8.11)', () => {
  it('marks read and unread', () => {
    const read = triageTaskInData(data({ eventAt: 10, visitedAt: 5 }), { taskId: 't1', action: 'read' }, NOW)
    expect(read).toMatchObject({ ok: true, changed: true })
    expect(inboxOf(read)).toEqual({ eventAt: 10, visitedAt: NOW })
    const unread = triageTaskInData(data({ eventAt: 10, visitedAt: 20 }), { taskId: 't1', action: 'unread' }, NOW)
    expect(inboxOf(unread)).toEqual({ eventAt: 10, visitedAt: 20, forcedUnread: true })
    const cleared = triageTaskInData(data({ visitedAt: 20, forcedUnread: true }), { taskId: 't1', action: 'read' }, NOW)
    expect(inboxOf(cleared)).toEqual({ visitedAt: NOW })
  })

  it('settles and unsettles', () => {
    const settled = triageTaskInData(data({ eventAt: 10, snoozedAt: 1, snoozedUntil: NOW + 1 }), { taskId: 't1', action: 'settle' }, NOW)
    expect(inboxOf(settled)).toEqual({ eventAt: 10, settledAt: NOW, visitedAt: NOW })
    const unsettled = triageTaskInData(data({ eventAt: 10, settledAt: 20 }), { taskId: 't1', action: 'unsettle' }, NOW)
    expect(inboxOf(unsettled)).toEqual({ eventAt: 10 })
  })

  it('snoozes until a time or until attention, and unsnoozes', () => {
    const timed = triageTaskInData(data({ settledAt: 5 }), { taskId: 't1', action: 'snooze', until: NOW + 3_600_000 }, NOW)
    expect(inboxOf(timed)).toEqual({ snoozedAt: NOW, visitedAt: NOW, snoozedUntil: NOW + 3_600_000 })
    const attention = triageTaskInData(data({ snoozedUntil: NOW + 5 }), { taskId: 't1', action: 'snooze', untilAttention: true }, NOW)
    expect(inboxOf(attention)).toEqual({ snoozedAt: NOW, visitedAt: NOW, snoozeUntilAttention: true })
    const woken = triageTaskInData(data({ snoozedAt: 1, snoozeUntilAttention: true }), { taskId: 't1', action: 'unsnooze' }, NOW)
    expect(inboxOf(woken)).toEqual({})
  })

  it('changes nothing when the inbox would show the same thing', () => {
    for (const [inbox, action] of [
      [{ eventAt: 10, visitedAt: 20 }, 'read'],
      [{ eventAt: 10, visitedAt: 5 }, 'unread'],
      [{ eventAt: 40, settledAt: 30 }, 'unsettle'],
      [{ snoozedAt: 1, snoozedUntil: NOW - 1 }, 'unsnooze'],
      [undefined, 'read']
    ] as const) {
      const start = data(inbox)
      expect(triageTaskInData(start, { taskId: 't1', action }, NOW), action).toEqual({ ok: true, data: start, changed: false })
    }
  })

  it('touches only the task it names', () => {
    const start = data({ eventAt: 10 })
    const result = triageTaskInData(start, { taskId: 't1', action: 'settle' }, NOW)
    if (!result.ok) throw new Error(result.code)
    expect(findTaskInProject(result.data.projects[0], 't2')).toBe(findTaskInProject(start.projects[0], 't2'))
    expect(result.data.projects[1]).toBe(start.projects[1])
  })

  it('answers not-found for what the phone cannot see', () => {
    const start = data()
    expect(triageTaskInData(start, { taskId: 'nope', action: 'read' }, NOW)).toMatchObject({ ok: false, code: 'not-found' })
    expect(triageTaskInData(start, { taskId: 'h1', action: 'settle' }, NOW)).toMatchObject({ ok: false, code: 'not-found' })
  })
})

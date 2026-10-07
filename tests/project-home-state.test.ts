import { describe, expect, it } from 'vitest'
import { projectHomeSummary, streamTone } from '../src/renderer/components/projectHomeState'
import type { Stream, Tab, TabStatusValue } from '../src/shared/types'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

const NOW = new Date('2026-10-07T12:00:00').getTime()

const tab = (id: string, type: Tab['type']): Tab => ({ id, type, title: id })

function stream(id: string, tasks: Stream['tasks']): Stream {
  return { id, name: id, tasks }
}

describe('streamTone', () => {
  const tasks = [
    fixtureTask({ id: 'a', tabs: { left: [tab('a1', 'claude')] } }),
    fixtureTask({ id: 'b', tabs: { left: [tab('b1', 'codex')] } }),
    fixtureTask({ id: 'c', tabs: { left: [tab('c1', 'claude-chat')] }, inbox: { eventAt: NOW - 1000 }, lastInteractedAt: NOW - 5000 })
  ]

  it('takes the strongest task: needs you over working over your turn', () => {
    const statuses: Record<string, TabStatusValue> = { a1: 'working', b1: 'attention' }
    expect(streamTone(stream('s', tasks), statuses, {}, NOW)).toBe('attention')
    expect(streamTone(stream('s', tasks), { a1: 'working' }, {}, NOW)).toBe('working')
    expect(streamTone(stream('s', tasks), {}, {}, NOW)).toBe('turn')
  })

  it('is quiet for an empty stream or one whose finished tasks are put away', () => {
    expect(streamTone(stream('s', []), {}, {}, NOW)).toBe('quiet')
    const snoozed = fixtureTask({ id: 'z', tabs: { left: [tab('z1', 'claude')] }, inbox: { eventAt: NOW - 1000, snoozedUntil: NOW + 60_000 } })
    const settled = fixtureTask({ id: 'y', tabs: { left: [tab('y1', 'claude')] }, inbox: { eventAt: NOW - 5000, settledAt: NOW - 1000 } })
    expect(streamTone(stream('s', [snoozed, settled]), {}, {}, NOW)).toBe('quiet')
  })
})

describe('projectHomeSummary', () => {
  it('counts open tasks, how many need you or work, and tasks by agent in a fixed order', () => {
    const project = fixtureProject({
      id: 'p',
      tasks: [
        { id: 't1', tabs: { left: [tab('t1a', 'terminal')] } },
        { id: 't2', tabs: { left: [tab('t2a', 'claude'), tab('t2b', 'terminal')] } },
        { id: 't3', tabs: { left: [tab('t3a', 'claude-chat')] } },
        { id: 't4', tabs: { left: [tab('t4a', 'claude-chat')] }, workspace: { worktreePath: '/w', branchName: 'b', baseBranch: 'main', relativeProjectPath: '' } },
        { id: 't5', tabs: { left: [tab('t5a', 'note')] } }
      ]
    })
    const summary = projectHomeSummary(project, { t2a: 'attention', t3a: 'working' }, {}, NOW)
    expect(summary.openTasks).toBe(5)
    expect(summary.needsYou).toBe(1)
    expect(summary.working).toBe(1)
    expect(summary.agents).toEqual([
      { label: 'Claude', count: 2 },
      { label: 'Claude Code', count: 1 },
      { label: 'Terminal', count: 1 }
    ])
  })
})

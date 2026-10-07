import { describe, expect, it } from 'vitest'
import {
  formatWaitTime,
  isSettled,
  isSnoozed,
  isUnread,
  isYourTurn,
  lastActivityAt,
  partitionInbox,
  snoozePresets,
  taskStatus,
  taskStatusSince
} from '../src/renderer/components/inbox'
import { createMainStream } from '../src/shared/types'
import type { Project, Task, TaskInboxState } from '../src/shared/types'
import { projectTasks, singlePane } from '../src/shared/streams'
import type { TabStatusValue } from '../src/renderer/context/TabStatusContext'

const NOW = new Date('2026-07-28T12:00:00').getTime()

function makeTask(id: string, inbox?: TaskInboxState, opts?: {
  lastInteractedAt?: number
  aiTabIds?: string[]
}): Task {
  return {
    id,
    name: id,
    panes: singlePane((opts?.aiTabIds ?? []).map(tabId => ({ id: tabId, type: 'claude' as const, title: 'Claude' }))),
    ...(opts?.lastInteractedAt !== undefined ? { lastInteractedAt: opts.lastInteractedAt } : {}),
    ...(inbox ? { inbox } : {})
  }
}

function makeProject(id: string, tasks: Task[]): Project {
  return { id, name: id, directory: `/tmp/${id}`, streams: [createMainStream(id, tasks)] }
}

describe('isUnread', () => {
  it('is false for a task nothing has happened in', () => {
    expect(isUnread(makeTask('t'))).toBe(false)
  })

  it('is true when an event landed after the last visit', () => {
    expect(isUnread(makeTask('t', { visitedAt: NOW - 5000, eventAt: NOW }))).toBe(true)
  })

  it('is false when the visit came after the event', () => {
    expect(isUnread(makeTask('t', { visitedAt: NOW, eventAt: NOW - 5000 }))).toBe(false)
  })

  it('honours a manual mark-unread even with no newer event', () => {
    expect(isUnread(makeTask('t', { visitedAt: NOW, eventAt: NOW - 5000, forcedUnread: true }))).toBe(true)
  })
})

describe('isSettled', () => {
  it('is true right after settling', () => {
    expect(isSettled(makeTask('t', { settledAt: NOW }))).toBe(true)
  })

  it('auto-unsettles when a later event arrives — settle is not a mute', () => {
    expect(isSettled(makeTask('t', { settledAt: NOW - 60_000, eventAt: NOW }))).toBe(false)
  })

  it('stays settled when the only event predates the settle', () => {
    expect(isSettled(makeTask('t', { settledAt: NOW, eventAt: NOW - 60_000 }))).toBe(true)
  })
})

describe('isSnoozed', () => {
  it('hides the task until the wake time', () => {
    const task = makeTask('t', { snoozedAt: NOW, snoozedUntil: NOW + 60_000 })
    expect(isSnoozed(task, NOW)).toBe(true)
    expect(isSnoozed(task, NOW + 60_001)).toBe(false)
  })

  it('survives events that would have unsettled a settle', () => {
    const task = makeTask('t', { snoozedAt: NOW, snoozedUntil: NOW + 60_000, eventAt: NOW + 1000 })
    expect(isSnoozed(task, NOW + 2000)).toBe(true)
  })

  it('"until it needs me" ignores a plain event', () => {
    const task = makeTask('t', { snoozedAt: NOW, snoozeUntilAttention: true, eventAt: NOW + 1000 })
    expect(isSnoozed(task, NOW + 2000)).toBe(true)
  })

  it('"until it needs me" wakes on an attention event', () => {
    const task = makeTask('t', {
      snoozedAt: NOW,
      snoozeUntilAttention: true,
      eventAt: NOW + 1000,
      attentionAt: NOW + 1000
    })
    expect(isSnoozed(task, NOW + 2000)).toBe(false)
  })

  it('ignores an attention event from before the snooze', () => {
    const task = makeTask('t', { snoozedAt: NOW, snoozeUntilAttention: true, attentionAt: NOW - 1000 })
    expect(isSnoozed(task, NOW)).toBe(true)
  })
})

describe('taskStatus', () => {
  it('rolls attention up over working', () => {
    const task = makeTask('t', undefined, { aiTabIds: ['a', 'b'] })
    const statuses: Record<string, TabStatusValue> = { a: 'working', b: 'attention' }
    expect(taskStatus(task, statuses)).toBe('attention')
  })

  it('is null when the task has no tabs at all', () => {
    expect(taskStatus(makeTask('t'), { a: 'attention' })).toBeNull()
  })

  it('counts terminal tabs too — a failed command is worth surfacing', () => {
    const task = makeTask('t')
    task.panes = singlePane([{ id: 'term', type: 'terminal', title: 'Terminal' }])
    expect(taskStatus(task, { term: 'attention' })).toBe('attention')
  })

  it('reports the oldest since stamp among tabs in that status', () => {
    const task = makeTask('t', undefined, { aiTabIds: ['a', 'b'] })
    const statuses: Record<string, TabStatusValue> = { a: 'attention', b: 'attention' }
    expect(taskStatusSince(task, statuses, { a: NOW - 1000, b: NOW - 9000 })).toBe(NOW - 9000)
  })

  it('has no since stamp after a restart wiped the in-memory store', () => {
    const task = makeTask('t', undefined, { aiTabIds: ['a'] })
    expect(taskStatusSince(task, { a: 'attention' }, {})).toBeNull()
  })
})

describe('isYourTurn', () => {
  it('is true once the agent stopped after your last input, read or not', () => {
    const task = makeTask('t', { eventAt: NOW, visitedAt: NOW + 5000 }, { lastInteractedAt: NOW - 60_000 })
    expect(isUnread(task)).toBe(false)
    expect(isYourTurn(task, null)).toBe(true)
  })

  it('hands the turn back once you type into the task', () => {
    const task = makeTask('t', { eventAt: NOW - 60_000 }, { lastInteractedAt: NOW })
    expect(isYourTurn(task, null)).toBe(false)
  })

  it('is never your turn while the agent is working', () => {
    const task = makeTask('t', { eventAt: NOW }, { lastInteractedAt: NOW - 60_000 })
    expect(isYourTurn(task, 'working')).toBe(false)
  })

  it('is always your turn when the agent is blocked on you', () => {
    const task = makeTask('t', { eventAt: NOW - 60_000 }, { lastInteractedAt: NOW })
    expect(isYourTurn(task, 'attention')).toBe(true)
  })

  it('is false for a task nothing has happened in', () => {
    expect(isYourTurn(makeTask('t'), null)).toBe(false)
  })
})

describe('lastActivityAt', () => {
  it('takes the later of our interaction and the agent\'s event', () => {
    expect(lastActivityAt(makeTask('t', { eventAt: NOW }, { lastInteractedAt: NOW - 5000 }))).toBe(NOW)
    expect(lastActivityAt(makeTask('t', { eventAt: NOW - 5000 }, { lastInteractedAt: NOW }))).toBe(NOW)
  })
})

describe('partitionInbox', () => {
  const blockedLong = makeTask('blocked-long', undefined, { aiTabIds: ['bl' ] })
  const blockedShort = makeTask('blocked-short', undefined, { aiTabIds: ['bs'] })
  const recent = makeTask('recent', { eventAt: NOW - 1000 })
  const older = makeTask('older', { eventAt: NOW - 60_000 })
  const settledTask = makeTask('settled', { settledAt: NOW - 1000 })
  const snoozedTask = makeTask('snoozed', { snoozedAt: NOW, snoozedUntil: NOW + 60_000 })

  const project = makeProject('p', [blockedLong, blockedShort, recent, older, settledTask, snoozedTask])
  const entries = projectTasks(project).map(task => ({ task, project }))
  const statuses: Record<string, TabStatusValue> = { bl: 'attention', bs: 'attention' }
  const since = { bl: NOW - 600_000, bs: NOW - 30_000 }

  it('splits tasks into the four groups', () => {
    const result = partitionInbox(entries, statuses, since, NOW)
    expect(result.needsYou.map(e => e.task.id)).toEqual(['blocked-long', 'blocked-short'])
    expect(result.active.map(e => e.task.id)).toEqual(['recent', 'older'])
    expect(result.settled.map(e => e.task.id)).toEqual(['settled'])
    expect(result.snoozed.map(e => e.task.id)).toEqual(['snoozed'])
  })

  it('sorts needsYou by longest wait first', () => {
    const result = partitionInbox(entries, statuses, since, NOW)
    expect(result.needsYou[0].task.id).toBe('blocked-long')
  })

  it('keeps a snoozed task out of needsYou even while it is blocked', () => {
    const snoozedAndBlocked = makeTask(
      'snoozed-blocked',
      { snoozedAt: NOW, snoozedUntil: NOW + 60_000 },
      { aiTabIds: ['sb'] }
    )
    const result = partitionInbox(
      [{ task: snoozedAndBlocked, project }],
      { sb: 'attention' },
      { sb: NOW - 1000 },
      NOW
    )
    expect(result.needsYou).toHaveLength(0)
    expect(result.snoozed).toHaveLength(1)
  })

  it('flags your-turn rows, but never settled or snoozed ones', () => {
    const settledAfterStop = makeTask('settled-stop', { eventAt: NOW - 5000, settledAt: NOW })
    const result = partitionInbox(
      [...entries, { task: settledAfterStop, project }],
      statuses,
      since,
      NOW
    )
    expect(result.needsYou.every(e => e.yourTurn)).toBe(true)
    expect(result.active.find(e => e.task.id === 'recent')?.yourTurn).toBe(true)
    expect(result.settled.every(e => !e.yourTurn)).toBe(true)
    expect(result.snoozed.every(e => !e.yourTurn)).toBe(true)
  })

  it('sinks working rows to the end of active only when asked', () => {
    const busy = makeTask('busy', { eventAt: NOW }, { aiTabIds: ['w'] })
    const withBusy = [...entries, { task: busy, project }]
    const working = { ...statuses, w: 'working' as const }
    expect(partitionInbox(withBusy, working, since, NOW).active.map(e => e.task.id))
      .toEqual(['busy', 'recent', 'older'])
    expect(partitionInbox(withBusy, working, since, NOW, { workingLast: true }).active.map(e => e.task.id))
      .toEqual(['recent', 'older', 'busy'])
  })
})

describe('snoozePresets', () => {
  it('leads with the event-driven preset', () => {
    const presets = snoozePresets(NOW)
    expect(presets[0].untilAttention).toBe(true)
    expect(presets[0].until).toBeUndefined()
  })

  it('drops "this evening" once the evening has passed', () => {
    const lateNight = new Date('2026-07-28T22:30:00').getTime()
    expect(snoozePresets(lateNight).some(p => p.id === 'evening')).toBe(false)
    expect(snoozePresets(NOW).some(p => p.id === 'evening')).toBe(true)
  })

  it('always wakes in the future', () => {
    for (const preset of snoozePresets(NOW)) {
      if (preset.until !== undefined) expect(preset.until).toBeGreaterThan(NOW)
    }
  })

  it('means next Monday when today is Monday', () => {
    const monday = new Date('2026-07-27T12:00:00').getTime()
    const preset = snoozePresets(monday).find(p => p.id === 'monday')!
    const days = (preset.until! - monday) / 86_400_000
    expect(days).toBeGreaterThan(6)
  })
})

describe('formatWaitTime', () => {
  it('steps through seconds, minutes, hours and days', () => {
    expect(formatWaitTime(5_000)).toBe('5s')
    expect(formatWaitTime(4 * 60_000)).toBe('4m')
    expect(formatWaitTime(3 * 3_600_000)).toBe('3h')
    expect(formatWaitTime(2 * 86_400_000)).toBe('2d')
  })

  it('clamps a negative interval to zero rather than printing a minus', () => {
    expect(formatWaitTime(-5000)).toBe('0s')
  })
})

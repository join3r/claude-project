import { describe, expect, it } from 'vitest'
import {
  formatWaitTime,
  groupInboxByProject,
  inboxSources,
  isSettled,
  isSnoozed,
  isUnread,
  isYourTurn,
  lastActivityAt,
  partitionInbox,
  snoozePresets,
  statusTabs,
  taskStatus,
  taskStatusSince
} from '../src/renderer/components/inbox'
import { createMainStream } from '../src/shared/types'
import type { Project, ProjectsData, Stream, Task, TaskInboxState } from '../src/shared/types'
import { singlePane } from '../src/shared/streams'
import { archiveStreamInData, archiveTasksInData } from '../src/shared/archive'
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

  it('a timed snooze wakes on an attention event too', () => {
    const task = makeTask('t', { snoozedAt: NOW, snoozedUntil: NOW + 60_000, attentionAt: NOW + 1000 })
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

  it('counts a terminal task\'s bell — its main tab is the terminal', () => {
    const task = makeTask('t')
    task.panes = singlePane([{ id: 'term', type: 'terminal', title: 'Terminal' }])
    task.mainTabId = 'term'
    expect(taskStatus(task, { term: 'attention' })).toBe('attention')
  })

  it('ignores an extra terminal beside the agent: it is a tool of the task, not the task', () => {
    const task = makeTask('t')
    task.panes = singlePane([
      { id: 'agent', type: 'claude', title: 'Claude' },
      { id: 'term', type: 'terminal', title: 'npm test' },
      { id: 'web', type: 'browser', title: 'localhost' }
    ])
    task.mainTabId = 'agent'
    expect(statusTabs(task).map(tab => tab.id)).toEqual(['agent'])
    expect(taskStatus(task, { term: 'attention', agent: 'working' })).toBe('working')
    expect(taskStatusSince(task, { term: 'attention', agent: 'working' }, { term: NOW - 9000, agent: NOW - 1000 }))
      .toBe(NOW - 1000)
  })

  it('still counts a second agent tab opened inside the task', () => {
    const task = makeTask('t', undefined, { aiTabIds: ['a', 'b'] })
    task.mainTabId = 'a'
    expect(taskStatus(task, { b: 'attention' })).toBe('attention')
  })

  it('falls back to the agent, else the terminal, when the task names no main tab', () => {
    const task = makeTask('t')
    task.panes = singlePane([
      { id: 'web', type: 'browser', title: 'localhost' },
      { id: 'term', type: 'terminal', title: 'Terminal' }
    ])
    expect(statusTabs(task).map(tab => tab.id)).toEqual(['term'])
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
  const stream = project.streams[0]
  const entries = inboxSources([project])
  const statuses: Record<string, TabStatusValue> = { bl: 'attention', bs: 'attention' }
  const since = { bl: NOW - 600_000, bs: NOW - 30_000 }

  it('splits tasks into the groups', () => {
    const result = partitionInbox(entries, statuses, since, NOW)
    expect(result.needsYou.map(e => e.task.id)).toEqual(['blocked-long', 'blocked-short'])
    expect(result.ready.map(e => e.task.id)).toEqual(['recent', 'older'])
    expect(result.working).toEqual([])
    expect(result.settled.map(e => e.task.id)).toEqual(['settled'])
    expect(result.snoozed.map(e => e.task.id)).toEqual(['snoozed'])
  })

  it('sorts needsYou by longest wait first', () => {
    const result = partitionInbox(entries, statuses, since, NOW)
    expect(result.needsYou[0].task.id).toBe('blocked-long')
  })

  it('puts a snoozed task that is blocked under needsYou', () => {
    const snoozedAndBlocked = makeTask(
      'snoozed-blocked',
      { snoozedAt: NOW, snoozedUntil: NOW + 60_000 },
      { aiTabIds: ['sb'] }
    )
    const result = partitionInbox(
      [{ task: snoozedAndBlocked, project, stream }],
      { sb: 'attention' },
      { sb: NOW - 1000 },
      NOW
    )
    expect(result.needsYou).toHaveLength(1)
    expect(result.snoozed).toHaveLength(0)
  })

  it('keeps a snoozed task under Snoozed once its agent is quiet again', () => {
    const snoozed = makeTask('snoozed-quiet', { snoozedAt: NOW, snoozedUntil: NOW + 60_000 }, { aiTabIds: ['sq'] })
    const result = partitionInbox([{ task: snoozed, project, stream }], { sq: null }, {}, NOW)
    expect(result.snoozed.map(e => e.task.id)).toEqual(['snoozed-quiet'])
  })

  it('flags your-turn rows, but never settled or snoozed ones', () => {
    const settledAfterStop = makeTask('settled-stop', { eventAt: NOW - 5000, settledAt: NOW })
    const result = partitionInbox(
      [...entries, { task: settledAfterStop, project, stream }],
      statuses,
      since,
      NOW
    )
    expect(result.needsYou.every(e => e.yourTurn)).toBe(true)
    expect(result.ready.find(e => e.task.id === 'recent')?.yourTurn).toBe(true)
    expect(result.settled.every(e => !e.yourTurn)).toBe(true)
    expect(result.snoozed.every(e => !e.yourTurn)).toBe(true)
  })

  it('splits Needs you, Ready and Working, with your-turn rows first in Ready', () => {
    const asking = makeTask('asking', { eventAt: NOW - 5000 }, { aiTabIds: ['ask'] })
    const finished = makeTask('finished', { eventAt: NOW - 3000 }, { lastInteractedAt: NOW - 10_000, aiTabIds: ['fin'] })
    const running = makeTask('running', { eventAt: NOW - 1000 }, { aiTabIds: ['run'] })
    const answered = makeTask('answered', { eventAt: NOW - 20_000 }, { lastInteractedAt: NOW - 2000, aiTabIds: ['ans'] })
    const untouched = makeTask('untouched', undefined, { aiTabIds: ['new'] })
    const exited = makeTask('exited', { eventAt: NOW - 4000 }, { lastInteractedAt: NOW - 9000, aiTabIds: ['ex'] })
    const result = partitionInbox(
      [asking, finished, running, answered, untouched, exited].map(task => ({ task, project, stream })),
      { ask: 'attention', run: 'working', ex: 'exited' },
      { ask: NOW - 5000, run: NOW - 1000 },
      NOW
    )
    expect(result.needsYou.map(e => e.task.id)).toEqual(['asking'])
    // Your turn is the agent having the last word without blocking: finished or exited.
    // Nothing owed either way follows, each part by recency.
    expect(result.ready.map(e => e.task.id)).toEqual(['finished', 'exited', 'answered', 'untouched'])
    expect(result.ready.map(e => e.yourTurn)).toEqual([true, true, false, false])
    expect(result.working.map(e => e.task.id)).toEqual(['running'])
    expect(result.working[0].yourTurn).toBe(false)
  })

  it('puts the task that started working last at the top of Working', () => {
    const early = makeTask('early', { eventAt: NOW - 1000 }, { aiTabIds: ['e1'] })
    const late = makeTask('late', { eventAt: NOW - 90_000 }, { aiTabIds: ['l1'] })
    const result = partitionInbox(
      [{ task: early, project, stream }, { task: late, project, stream }],
      { e1: 'working', l1: 'working' },
      { e1: NOW - 60_000, l1: NOW - 2000 },
      NOW
    )
    expect(result.working.map(e => e.task.id)).toEqual(['late', 'early'])
  })

  it('puts a working task you settled or snoozed under Working', () => {
    const settled = makeTask('settled-busy', { eventAt: NOW - 5000, settledAt: NOW }, { aiTabIds: ['w1'] })
    const snoozed = makeTask('snoozed-busy', { snoozedAt: NOW, snoozedUntil: NOW + 60_000 }, { aiTabIds: ['w2'] })
    const result = partitionInbox(
      [{ task: settled, project, stream }, { task: snoozed, project, stream }],
      { w1: 'working', w2: 'working' },
      {},
      NOW
    )
    expect(result.working.map(e => e.task.id).sort()).toEqual(['settled-busy', 'snoozed-busy'])
    expect(result.settled).toEqual([])
    expect(result.snoozed).toEqual([])
  })
})

describe('inbox sources and the grouped layout', () => {
  function streamOf(id: string, name: string, tasks: Task[]): Stream {
    return { id, name, tasks }
  }

  // DevTool: main (quiet, recent), 0.5.0 (one blocked, one older), bugfixes (newest event).
  const quiet = makeTask('quiet', { eventAt: NOW - 50_000 })
  const blocked = makeTask('blocked', undefined, { aiTabIds: ['b'] })
  const older = makeTask('older', { eventAt: NOW - 90_000 })
  const fresh = makeTask('fresh', { eventAt: NOW - 1000 })
  const termTask = makeTask('term-task', { eventAt: NOW - 70_000 })
  termTask.panes = singlePane([{ id: 'bell', type: 'terminal', title: 'Terminal' }])
  termTask.mainTabId = 'bell'
  const devtool: Project = {
    id: 'devtool',
    name: 'DevTool',
    directory: '/tmp/devtool',
    streams: [
      createMainStream('devtool', [quiet]),
      streamOf('s050', '0.5.0', [older, blocked]),
      streamOf('sfix', 'bugfixes', [fresh])
    ]
  }
  const stem: Project = {
    id: 'stem',
    name: 'Stem',
    directory: '/tmp/stem',
    streams: [createMainStream('stem', [termTask])]
  }
  const statuses: Record<string, TabStatusValue> = { b: 'attention', bell: 'attention' }
  const since = { b: NOW - 5_000, bell: NOW - 60_000 }

  it('lists every task with its project and stream', () => {
    const sources = inboxSources([devtool, stem])
    expect(sources.map(s => `${s.project.id}/${s.stream.name}/${s.task.id}`)).toEqual([
      'devtool/main/quiet', 'devtool/0.5.0/older', 'devtool/0.5.0/blocked', 'devtool/bugfixes/fresh', 'stem/main/term-task'
    ])
  })

  it('puts a terminal task whose bell rang under Needs you', () => {
    const { needsYou } = partitionInbox(inboxSources([devtool, stem]), statuses, since, NOW)
    expect(needsYou.map(e => e.task.id)).toEqual(['term-task', 'blocked'])
    expect(needsYou[0].yourTurn).toBe(true)
  })

  it('flat order: needs you by longest wait, then ready by recency', () => {
    const { needsYou, ready } = partitionInbox(inboxSources([devtool, stem]), statuses, since, NOW)
    expect([...needsYou, ...ready].map(e => e.task.id))
      .toEqual(['term-task', 'blocked', 'fresh', 'quiet', 'older'])
  })

  it('grouped: a project sits where its most urgent row is, its rows in flat order across streams', () => {
    const { needsYou, ready } = partitionInbox(inboxSources([devtool, stem]), statuses, since, NOW)
    const groups = groupInboxByProject([...needsYou, ...ready])
    expect(groups.map(g => `${g.project.name}: ${g.entries.map(e => `${e.stream.name}/${e.task.id}`).join(',')}`)).toEqual([
      'Stem: main/term-task',
      'DevTool: 0.5.0/blocked,bugfixes/fresh,main/quiet,0.5.0/older'
    ])
  })

  it('grouped: pinned projects come first, in pin order', () => {
    const { needsYou, ready } = partitionInbox(inboxSources([devtool, stem]), statuses, since, NOW)
    const entries = [...needsYou, ...ready]
    expect(groupInboxByProject(entries, ['devtool']).map(g => g.project.id)).toEqual(['devtool', 'stem'])
    expect(groupInboxByProject(entries, ['gone', 'stem', 'devtool']).map(g => g.project.id)).toEqual(['stem', 'devtool'])
  })

  it('keeps two projects apart even when both only have main', () => {
    const { ready } = partitionInbox(inboxSources([devtool, stem]), {}, {}, NOW)
    expect(groupInboxByProject(ready).map(g => g.project.id).sort()).toEqual(['devtool', 'stem'])
  })

  it('never lists archived tasks or the tasks of an archived stream', () => {
    const data: ProjectsData = { projects: [devtool, stem], projectOrder: ['devtool', 'stem'] } as ProjectsData
    const afterTask = archiveTasksInData(data, 'devtool', ['fresh'])
    const afterStream = archiveStreamInData(afterTask, 'devtool', 's050')
    const ids = inboxSources(afterStream.projects).map(s => s.task.id)
    expect(ids).toEqual(['quiet', 'term-task'])
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

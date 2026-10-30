import { describe, expect, it } from 'vitest'
import { inboxSources, partitionInbox } from '../src/renderer/components/inbox'
import {
  composeTarget,
  deskLists,
  deskTabCounts,
  doneEntries,
  keyTarget,
  liveScope,
  nextNeedsYou,
  pinnedFirst,
  scopeLabel,
  scopeSources,
  shownRows,
  stepRow,
  taskBackground
} from '../src/renderer/components/desk/deskInbox'
import { deskSnoozeChoices, wakeHint } from '../src/renderer/components/desk/deskSnooze'
import { createMainStream, normalizeDeskViewState } from '../src/shared/types'
import type { Project, Stream, Task, TaskInboxState } from '../src/shared/types'
import type { ProjectArchive } from '../src/shared/archive'
import { singlePane } from '../src/shared/streams'
import { answerPreview, emptyActivity, type AgentActivity } from '../src/shared/agent-activity'
import type { TabStatusValue } from '../src/renderer/context/TabStatusContext'

const NOW = new Date('2026-10-30T12:00:00').getTime()

function task(id: string, inbox?: TaskInboxState, extra?: Partial<Task>): Task {
  return {
    id,
    name: id,
    panes: singlePane([{ id: `${id}-tab`, type: 'claude-chat' as const, title: 'Claude' }]),
    ...(inbox ? { inbox } : {}),
    ...extra
  }
}

function stream(id: string, tasks: Task[]): Stream {
  return { id, name: id, tasks }
}

function project(id: string, tasks: Task[], streams: Stream[] = []): Project {
  return { id, name: id, directory: `/tmp/${id}`, streams: [createMainStream(id, tasks), ...streams] }
}

function lists(projects: Project[], statuses: Record<string, TabStatusValue> = {}) {
  return deskLists(partitionInbox(inboxSources(projects), statuses, {}, NOW))
}

describe('deskLists', () => {
  it('splits the classic Ready group into Answered and Waiting on you', () => {
    const answered = task('answered', { eventAt: NOW - 1000 }, { lastInteractedAt: NOW - 5000 })
    const waiting = task('waiting', undefined, { lastInteractedAt: NOW - 5000 })
    const result = lists([project('p', [answered, waiting])])
    expect(result.answered.map(e => e.task.id)).toEqual(['answered'])
    expect(result.waiting.map(e => e.task.id)).toEqual(['waiting'])
  })

  it('puts a stopped landing in Needs you, and keeps one being fixed in Working', () => {
    const conflict = task('conflict', undefined, { landing: { state: 'conflict', files: ['a.ts'] } })
    const fixing = task('fixing', undefined, { landing: { state: 'fixing' } })
    const result = lists([project('p', [conflict, fixing])], { 'fixing-tab': 'working' })
    expect(result.needsYou.map(e => e.task.id)).toEqual(['conflict'])
    expect(result.working.map(e => e.task.id)).toEqual(['fixing'])
  })

  it('an Autopilot run between turns is Working; one handed back is Needs you until you write', () => {
    const reviewing = task('reviewing', undefined, { autopilot: { phase: 'reviewing', review: true } })
    const stopped = task('stopped', undefined, { autopilot: { phase: 'stopped', reason: 'No files changed', stoppedAt: NOW - 1000 }, lastInteractedAt: NOW - 5000 })
    const answered = task('answered', { eventAt: NOW - 500 }, { autopilot: { phase: 'stopped', stoppedAt: NOW - 1000 }, lastInteractedAt: NOW - 800 })
    const result = lists([project('p', [reviewing, stopped, answered])])
    expect(result.working.map(e => e.task.id)).toEqual(['reviewing'])
    expect(result.needsYou.map(e => e.task.id)).toEqual(['stopped'])
    expect(result.answered.map(e => e.task.id)).toEqual(['answered'])
  })

  it('counts unread Inbox rows and every Working row', () => {
    const unread = task('unread', { eventAt: NOW - 1000, visitedAt: NOW - 5000 })
    const read = task('read', { eventAt: NOW - 5000, visitedAt: NOW - 1000 })
    const busy = task('busy')
    const counts = deskTabCounts(lists([project('p', [unread, read, busy])], { 'busy-tab': 'working' }))
    expect(counts).toEqual({ inbox: 1, working: 1, snoozed: null, done: null })
  })
})

describe('scope', () => {
  const a = project('a', [task('a1')], [stream('a-s', [task('a2')])])
  const b = project('b', [task('b1')])

  it('narrows to a project, or to one of its streams', () => {
    const sources = inboxSources([a, b])
    expect(scopeSources(sources, null).map(s => s.task.id)).toEqual(['a1', 'a2', 'b1'])
    expect(scopeSources(sources, { projectId: 'a' }).map(s => s.task.id)).toEqual(['a1', 'a2'])
    expect(scopeSources(sources, { projectId: 'a', streamId: 'a-s' }).map(s => s.task.id)).toEqual(['a2'])
  })

  it('labels the scope', () => {
    expect(scopeLabel([a, b], null)).toBe('All projects')
    expect(scopeLabel([a, b], { projectId: 'a' })).toBe('a')
    expect(scopeLabel([a, b], { projectId: 'a', streamId: 'a-s' })).toBe('a › a-s')
    expect(scopeLabel([a, b], { projectId: 'gone' })).toBe('All projects')
  })

  it('aims compose at the scope, else the project and stream last fired into', () => {
    expect(composeTarget([a, b], { projectId: 'a', streamId: 'a-s' }, { projectId: 'b' })).toMatchObject({ project: { id: 'a' }, stream: { id: 'a-s' } })
    expect(composeTarget([a, b], null, { projectId: 'b' })).toMatchObject({ project: { id: 'b' }, stream: undefined })
    expect(composeTarget([a, b], null, { projectId: 'a', streamId: 'a-s' })).toMatchObject({ project: { id: 'a' }, stream: { id: 'a-s' } })
    expect(composeTarget([a, b], { projectId: 'a' }, { projectId: 'a', streamId: 'a-s' })).toMatchObject({ project: { id: 'a' }, stream: { id: 'a-s' } })
    expect(composeTarget([a, b], { projectId: 'b' }, { projectId: 'a', streamId: 'a-s' })).toMatchObject({ project: { id: 'b' }, stream: undefined })
    expect(composeTarget([a, b], null, { projectId: 'a', streamId: 'gone' })).toMatchObject({ project: { id: 'a' }, stream: undefined })
    expect(composeTarget([a, b], null, null)?.project.id).toBe('a')
    expect(composeTarget([], null, null)).toBeNull()
  })

  it('drops a stored scope whose project is gone', () => {
    expect(normalizeDeskViewState({ scope: { projectId: 'gone' }, tab: 'done', width: 500 }, [a])).toEqual({ tab: 'done', width: 500 })
    expect(normalizeDeskViewState({ scope: { projectId: 'a', streamId: 'gone' } }, [a])).toEqual({ scope: { projectId: 'a' } })
    expect(normalizeDeskViewState({ tab: 'bogus' }, [a])).toEqual({})
  })

  it('applies a scope whose project or stream went away meanwhile as All, or as its project', () => {
    const scope = { projectId: 'a', streamId: 'a-s' }
    expect(liveScope([a, b], scope)).toBe(scope)
    expect(liveScope([b], scope)).toBeNull()
    expect(liveScope([project('a', [task('a1')]), b], scope)).toEqual({ projectId: 'a' })
    expect(liveScope([a], null)).toBeNull()
    // The list and the label then agree: All lists every task.
    expect(scopeSources(inboxSources([b]), liveScope([b], scope)).map(s => s.task.id)).toEqual(['b1'])
  })
})

describe('keyTarget', () => {
  it('prefers the hovered row, then the selected one', () => {
    const rows = inboxSources([project('p', [task('x'), task('y')])]).map(s => ({ ...s, status: null, since: null, unread: false, yourTurn: false }))
    expect(keyTarget(rows, 'y', 'x')?.task.id).toBe('y')
    expect(keyTarget(rows, null, 'x')?.task.id).toBe('x')
    expect(keyTarget(rows, 'elsewhere', null)).toBeNull()
  })
})

describe('doneEntries', () => {
  it('lists archived tasks of all projects, newest first, within the window', () => {
    const p = project('p', [])
    const q = project('q', [])
    const archives = new Map<string, ProjectArchive>([
      ['p', { version: 1, tasks: [
        { task: task('old'), streamId: 'p', streamName: 'main', dir: '/tmp/p', archivedAt: NOW - 40 * 86400_000 },
        { task: task('recent'), streamId: 'p', streamName: 'main', dir: '/tmp/p', archivedAt: NOW - 1000 }
      ], streams: [] }],
      ['q', { version: 1, tasks: [], streams: [{
        stream: stream('q-s', [task('closed-with-stream')]), doneTasks: [], dir: '/tmp/q', archivedAt: NOW - 5000
      }] }]
    ])
    const since = NOW - 30 * 86400_000
    expect(doneEntries([p, q], archives, null, since).map(e => e.entry.task.id)).toEqual(['recent', 'closed-with-stream'])
    expect(doneEntries([p, q], archives, null, null).map(e => e.entry.task.id)).toEqual(['recent', 'closed-with-stream', 'old'])
    expect(doneEntries([p, q], archives, { projectId: 'q' }, null).map(e => e.entry.task.id)).toEqual(['closed-with-stream'])
  })
})

describe('desk snooze', () => {
  it('offers the board order, dropping This evening once it is past', () => {
    expect(deskSnoozeChoices(NOW).map(c => c.id)).toEqual(['tomorrow', 'evening', 'monday', 'attention'])
    const late = new Date('2026-10-30T19:00:00').getTime()
    expect(deskSnoozeChoices(late).map(c => c.id)).toEqual(['tomorrow', 'monday', 'attention'])
  })

  it('wakes next Monday at 9, a week out on a Monday', () => {
    const monday = new Date('2026-11-02T08:00:00').getTime()
    const next = deskSnoozeChoices(monday).find(c => c.id === 'monday')!
    expect(new Date(next.until!).getDate()).toBe(9)
    expect(wakeHint(next.until!, true)).toBe('Mon 9:00')
  })
})

describe('answerPreview', () => {
  it('flattens Markdown into one paragraph', () => {
    expect(answerPreview('## Fixed\n\n- The list **now** scrolls\n- `npm test` passes\n\n```ts\ncode()\n```\nSee [docs](http://x).'))
      .toBe('Fixed The list now scrolls npm test passes See docs.')
  })

  it('caps the length', () => {
    expect(answerPreview('a'.repeat(400))!.length).toBe(320)
  })
})

describe('taskBackground', () => {
  const shell = { id: 'b1', type: 'local_bash', label: 'xcodebuild', startedAt: NOW - 180_000 }
  const between = (extra: Partial<AgentActivity> = {}): AgentActivity =>
    ({ ...emptyActivity(NOW), background: 1, backgroundTasks: [shell], ...extra })

  it('is set when the turn ended but its work still runs', () => {
    const t = task('t')
    expect(taskBackground(t, { 't-tab': between() })).toEqual({ tasks: [shell], label: 'xcodebuild', since: NOW - 180_000, tabId: 't-tab' })
  })

  it('is plain Working while a turn is in flight, and nothing when no work runs', () => {
    const t = task('t')
    expect(taskBackground(t, { 't-tab': between({ turnStartedAt: NOW }) })).toBeNull()
    expect(taskBackground(t, { 't-tab': emptyActivity(NOW) })).toBeNull()
    expect(taskBackground(t, {})).toBeNull()
  })

  it('is not Background when another agent tab of the task is mid-turn', () => {
    const t = task('t', undefined, {
      panes: singlePane([
        { id: 'chat', type: 'claude-chat' as const, title: 'Claude' },
        { id: 'tui', type: 'claude' as const, title: 'Claude' }
      ])
    })
    expect(taskBackground(t, { chat: between(), tui: { ...emptyActivity(NOW), turnStartedAt: NOW } })).toBeNull()
    expect(taskBackground(t, { chat: between(), tui: emptyActivity(NOW) })?.tabId).toBe('chat')
  })
})

describe('pins, grouping and row keys', () => {
  const entries = () => {
    const a = project('a', [task('a1'), task('a2')])
    const b = project('b', [task('b1')])
    return inboxSources([a, b]).map(({ project, stream, task }) => ({ project, stream, task, status: null, since: null, unread: false, yourTurn: false }))
  }

  it('puts pinned tasks first and keeps the rest in order', () => {
    expect(pinnedFirst(entries(), new Set(['b1', 'a2'])).map(e => e.task.id)).toEqual(['a2', 'b1', 'a1'])
    expect(pinnedFirst(entries(), new Set()).map(e => e.task.id)).toEqual(['a1', 'a2', 'b1'])
  })

  it('steps through the rows from the selection, starting at an end without one', () => {
    const rows = entries()
    expect(stepRow(rows, null, 1)?.task.id).toBe('a1')
    expect(stepRow(rows, null, -1)?.task.id).toBe('b1')
    expect(stepRow(rows, 'a1', 1)?.task.id).toBe('a2')
    expect(stepRow(rows, 'a1', -1)).toBeNull()
    expect(stepRow(rows, 'b1', 1)).toBeNull()
    expect(stepRow([], 'a1', 1)).toBeNull()
  })

  it('jumps to the next task that needs you, wrapping round', () => {
    const rows = entries()
    expect(nextNeedsYou(rows, null)?.task.id).toBe('a1')
    expect(nextNeedsYou(rows, 'a2')?.task.id).toBe('b1')
    expect(nextNeedsYou(rows, 'b1')?.task.id).toBe('a1')
    expect(nextNeedsYou([], 'a1')).toBeNull()
  })

  it('walks grouped rows project by project, as the column draws them', () => {
    const a = project('a', [task('a1'), task('a2')])
    const b = project('b', [task('b1')])
    const at = (p: Project, id: string) => ({ project: p, stream: p.streams[0], task: p.streams[0].tasks.find(t => t.id === id)!, status: null, since: null, unread: false, yourTurn: false })
    // Needs you a2, b1; then answered a1: by status the walk would go a2 → b1 → a1.
    const rows = [at(a, 'a2'), at(b, 'b1'), at(a, 'a1')]
    expect(shownRows(rows, false, []).map(e => e.task.id)).toEqual(['a2', 'b1', 'a1'])
    expect(shownRows(rows, true, []).map(e => e.task.id)).toEqual(['a2', 'a1', 'b1'])
    expect(shownRows(rows, true, ['b']).map(e => e.task.id)).toEqual(['b1', 'a2', 'a1'])
    expect(stepRow(shownRows(rows, true, []), 'a2', 1)?.task.id).toBe('a1')
  })
})

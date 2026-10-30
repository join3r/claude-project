import { describe, expect, it } from 'vitest'
import { inboxSources, partitionInbox } from '../src/renderer/components/inbox'
import {
  composeTarget,
  deskLists,
  deskTabCounts,
  doneEntries,
  keyTarget,
  scopeLabel,
  scopeSources
} from '../src/renderer/components/desk/deskInbox'
import { deskSnoozeChoices, wakeHint } from '../src/renderer/components/desk/deskSnooze'
import { createMainStream, normalizeDeskViewState } from '../src/shared/types'
import type { Project, Stream, Task, TaskInboxState } from '../src/shared/types'
import type { ProjectArchive } from '../src/shared/archive'
import { singlePane } from '../src/shared/streams'
import { answerPreview } from '../src/shared/agent-activity'
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

  it('aims compose at the scope, else the project last fired into', () => {
    expect(composeTarget([a, b], { projectId: 'a', streamId: 'a-s' }, 'b')).toMatchObject({ project: { id: 'a' }, stream: { id: 'a-s' } })
    expect(composeTarget([a, b], null, 'b')).toMatchObject({ project: { id: 'b' }, stream: undefined })
    expect(composeTarget([a, b], null, null)?.project.id).toBe('a')
    expect(composeTarget([], null, null)).toBeNull()
  })

  it('drops a stored scope whose project is gone', () => {
    expect(normalizeDeskViewState({ scope: { projectId: 'gone' }, tab: 'done', width: 500 }, [a])).toEqual({ tab: 'done', width: 500 })
    expect(normalizeDeskViewState({ scope: { projectId: 'a', streamId: 'gone' } }, [a])).toEqual({ scope: { projectId: 'a' } })
    expect(normalizeDeskViewState({ tab: 'bogus' }, [a])).toEqual({})
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

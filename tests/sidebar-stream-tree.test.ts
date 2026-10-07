import { describe, expect, it } from 'vitest'
import { mainStreamId, type ProjectsData, type Stream, type Tab, type Task } from '../src/shared/types'
import {
  extraTabCount,
  formatActivityAge,
  isQuietStream,
  isStreamExpanded,
  resolveTaskMove,
  rollUpState,
  sidebarTaskState,
  taskDropSlot,
  type TreeRowLayout
} from '../src/renderer/components/sidebar/streamTree'
import { moveTaskInData, removeStreamFromData, renameStreamInData } from '../src/renderer/hooks/appState/projectsData'
import { runsInTaskDir } from '../src/shared/streams'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

const tab = (id: string, type: Tab['type']): Tab => ({ id, type, title: id } as Tab)
const NOW = 1_000_000_000

describe('sidebarTaskState', () => {
  const task = fixtureTask({ id: 't', tabs: { left: [tab('agent', 'claude'), tab('term', 'terminal')] } })

  it('reads the agent and main tabs, not the extra terminals', () => {
    expect(sidebarTaskState(task, { agent: 'working' }, NOW)).toBe('working')
    expect(sidebarTaskState(task, { agent: 'working', term: 'attention' }, NOW)).toBe('working')
    expect(sidebarTaskState(task, { agent: 'exited' }, NOW)).toBe('exited')
    expect(sidebarTaskState(task, {}, NOW)).toBeNull()
  })

  it('counts a terminal task\'s bell on its main tab', () => {
    const terminalTask = fixtureTask({ id: 'tt', tabs: { left: [tab('sh', 'terminal')] } })
    expect(sidebarTaskState(terminalTask, { sh: 'attention' }, NOW)).toBe('attention')
  })

  it('is unread when something happened since the last visit, unless settled or snoozed', () => {
    const unread: Task = { ...task, inbox: { eventAt: NOW - 10, visitedAt: NOW - 20 } }
    expect(sidebarTaskState(unread, {}, NOW)).toBe('unread')
    expect(sidebarTaskState(unread, { agent: 'attention' }, NOW)).toBe('attention')
    expect(sidebarTaskState({ ...unread, inbox: { ...unread.inbox, settledAt: NOW - 5 } }, {}, NOW)).toBeNull()
    expect(sidebarTaskState({ ...unread, inbox: { ...unread.inbox, snoozedUntil: NOW + 60_000 } }, {}, NOW)).toBeNull()
  })
})

describe('rollUpState', () => {
  it('takes the strongest state of the tasks inside', () => {
    expect(rollUpState([])).toBeNull()
    expect(rollUpState([null, 'exited'])).toBe('exited')
    expect(rollUpState(['exited', 'unread', null])).toBe('unread')
    expect(rollUpState(['unread', 'working'])).toBe('working')
    expect(rollUpState(['working', 'attention', 'unread'])).toBe('attention')
  })
})

describe('auto-collapse', () => {
  const stream = (tasks: Task[]): Stream => ({ id: 's', name: 's', tasks })
  const a = fixtureTask({ id: 'a' })
  const b = fixtureTask({ id: 'b' })

  it('calls a stream quiet when no task needs you, runs or has news', () => {
    expect(isQuietStream(stream([a, b]), () => null)).toBe(true)
    expect(isQuietStream(stream([a, b]), () => 'exited')).toBe(true)
    expect(isQuietStream(stream([]), () => 'attention')).toBe(true)
    for (const live of ['attention', 'working', 'unread'] as const) {
      expect(isQuietStream(stream([a, b]), task => (task.id === 'b' ? live : null))).toBe(false)
    }
  })

  it('folds a quiet stream only with the setting on, unless it holds the selection', () => {
    const base = { override: undefined, holdsSelection: false }
    expect(isStreamExpanded({ ...base, autoCollapse: true, quiet: true })).toBe(false)
    expect(isStreamExpanded({ ...base, autoCollapse: true, quiet: false })).toBe(true)
    expect(isStreamExpanded({ ...base, autoCollapse: false, quiet: true })).toBe(true)
    expect(isStreamExpanded({ ...base, autoCollapse: true, quiet: true, holdsSelection: true })).toBe(true)
  })

  it('lets a chevron click win either way', () => {
    expect(isStreamExpanded({ override: true, autoCollapse: true, quiet: true, holdsSelection: false })).toBe(true)
    expect(isStreamExpanded({ override: false, autoCollapse: false, quiet: false, holdsSelection: true })).toBe(false)
  })
})

describe('task row details', () => {
  it('counts the tabs beyond the main one', () => {
    expect(extraTabCount(fixtureTask({ id: 'x' }))).toBe(0)
    expect(extraTabCount(fixtureTask({ id: 'x', tabs: { left: [tab('a', 'claude')] } }))).toBe(0)
    expect(extraTabCount(fixtureTask({ id: 'x', tabs: { left: [tab('a', 'claude'), tab('b', 'terminal')], right: [tab('c', 'browser')] } }))).toBe(2)
  })

  it('formats the last activity as minutes, hours or days', () => {
    const at = (ago: number): Task => fixtureTask({ id: 'x', lastInteractedAt: NOW - ago })
    expect(formatActivityAge(fixtureTask({ id: 'x' }), NOW)).toBeNull()
    expect(formatActivityAge(at(5_000), NOW)).toBe('1m')
    expect(formatActivityAge(at(4 * 60_000), NOW)).toBe('4m')
    expect(formatActivityAge(at(3 * 3_600_000), NOW)).toBe('3h')
    expect(formatActivityAge(at(2 * 86_400_000), NOW)).toBe('2d')
  })
})

describe('dragging tasks between streams', () => {
  // main: [a, b] (rows at 0..60), rel: [c] (rows at 60..100)
  const rows: TreeRowLayout[] = [
    { kind: 'stream', streamId: 'main', index: -1, taskCount: 2, top: 0, height: 20 },
    { kind: 'task', streamId: 'main', index: 0, taskId: 'a', top: 20, height: 20 },
    { kind: 'task', streamId: 'main', index: 1, taskId: 'b', top: 40, height: 20 },
    { kind: 'stream', streamId: 'rel', index: -1, taskCount: 1, top: 60, height: 20 },
    { kind: 'task', streamId: 'rel', index: 0, taskId: 'c', top: 80, height: 20 }
  ]

  it('drops before or after the task under the cursor', () => {
    expect(taskDropSlot(rows, 25)).toEqual({ streamId: 'main', index: 0, onStreamRow: false })
    expect(taskDropSlot(rows, 35)).toEqual({ streamId: 'main', index: 1, onStreamRow: false })
    expect(taskDropSlot(rows, 95)).toEqual({ streamId: 'rel', index: 1, onStreamRow: false })
  })

  it('appends to a stream when the cursor is on its row', () => {
    expect(taskDropSlot(rows, 65)).toEqual({ streamId: 'rel', index: 1, onStreamRow: true })
    expect(taskDropSlot(rows, 5)).toEqual({ streamId: 'main', index: 2, onStreamRow: true })
  })

  it('clamps to the first or last row outside the tree', () => {
    expect(taskDropSlot(rows, -50)).toEqual({ streamId: 'main', index: 2, onStreamRow: true })
    expect(taskDropSlot(rows, 500)).toEqual({ streamId: 'rel', index: 1, onStreamRow: false })
    expect(taskDropSlot([], 10)).toBeNull()
  })

  it('turns a slot into a move, or nothing for the task\'s own place', () => {
    const from = { streamId: 'main', index: 0 }
    expect(resolveTaskMove(from, { streamId: 'main', index: 0, onStreamRow: false })).toBeNull()
    expect(resolveTaskMove(from, { streamId: 'main', index: 1, onStreamRow: false })).toBeNull()
    expect(resolveTaskMove(from, { streamId: 'main', index: 2, onStreamRow: true })).toEqual({ toStreamId: 'main', toIndex: 1 })
    expect(resolveTaskMove({ streamId: 'main', index: 1 }, { streamId: 'main', index: 0, onStreamRow: false })).toEqual({ toStreamId: 'main', toIndex: 0 })
    expect(resolveTaskMove(from, { streamId: 'rel', index: 1, onStreamRow: true })).toEqual({ toStreamId: 'rel', toIndex: 1 })
    expect(resolveTaskMove(from, { streamId: 'rel', index: 0, onStreamRow: false })).toEqual({ toStreamId: 'rel', toIndex: 0 })
  })
})

describe('stream data ops', () => {
  const worktree = { worktreePath: '/wt/c', branchName: 'c', baseBranch: 'main', relativeProjectPath: '' }
  function data(): ProjectsData {
    const project = fixtureProject({
      id: 'p',
      tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c', workspace: worktree }],
      lastTaskId: 'a'
    })
    return {
      projects: [project],
      tags: [],
      projectOrder: ['p'],
      pinnedItems: [{ type: 'task', projectId: 'p', streamId: mainStreamId('p'), taskId: 'a' }]
    }
  }
  const ids = (d: ProjectsData) => d.projects[0].streams.map(s => [s.id, s.tasks.map(t => t.id)])

  it('reorders within a stream', () => {
    const next = moveTaskInData(data(), 'p', 'a', mainStreamId('p'), 1)
    expect(ids(next)).toEqual([[mainStreamId('p'), ['b', 'a']], ['stream-c', ['c']]])
  })

  it('returns the same data for a move to the task\'s own place', () => {
    const before = data()
    expect(moveTaskInData(before, 'p', 'a', mainStreamId('p'), 0)).toBe(before)
    expect(moveTaskInData(before, 'p', 'missing', mainStreamId('p'), 0)).toBe(before)
    expect(moveTaskInData(before, 'p', 'a', 'no-such-stream', 0)).toBe(before)
  })

  it('moves between streams; the pin and "last task" follow, the emptied stream stays', () => {
    const next = moveTaskInData(data(), 'p', 'c', mainStreamId('p'), 0)
    expect(ids(next)).toEqual([[mainStreamId('p'), ['c', 'a', 'b']], ['stream-c', []]])
    expect(next.projects[0].streams[1].workspace).toEqual(worktree)

    const moved = moveTaskInData(data(), 'p', 'a', 'stream-c', 5)
    expect(ids(moved)).toEqual([[mainStreamId('p'), ['b']], ['stream-c', ['c', 'a']]])
    expect(moved.pinnedItems).toEqual([{ type: 'task', projectId: 'p', streamId: 'stream-c', taskId: 'a' }])
    expect(moved.projects[0].lastStreamId).toBe('stream-c')
    expect(moved.projects[0].streams[1].lastTaskId).toBe('a')
    expect(moved.projects[0].streams[0].lastTaskId).toBeUndefined()
  })

  it('removes a stream with its tasks and pins, never main', () => {
    const before: ProjectsData = {
      ...data(),
      pinnedItems: [
        { type: 'stream', projectId: 'p', streamId: 'stream-c' },
        { type: 'task', projectId: 'p', streamId: 'stream-c', taskId: 'c' },
        { type: 'project', projectId: 'p' }
      ]
    }
    const next = removeStreamFromData(before, 'p', 'stream-c')
    expect(ids(next)).toEqual([[mainStreamId('p'), ['a', 'b']]])
    expect(next.pinnedItems).toEqual([{ type: 'project', projectId: 'p' }])
    expect(removeStreamFromData(before, 'p', mainStreamId('p'))).toBe(before)
  })

  it('drops a hidden ad-hoc project whose last stream goes', () => {
    const adhoc = fixtureProject({ id: 'q', ephemeral: true, tasks: [{ id: 'x', workspace: worktree }] })
    const before: ProjectsData = { projects: [adhoc], tags: [], projectOrder: ['q'], pinnedItems: [] }
    const next = removeStreamFromData(before, 'q', 'stream-x')
    expect(next.projects).toEqual([])
    expect(next.projectOrder).toEqual([])
  })

  it('renames a stream and leaves its branch alone', () => {
    const next = renameStreamInData(data(), 'p', 'stream-c', '0.5.0')
    expect(next.projects[0].streams[1]).toMatchObject({ name: '0.5.0', workspace: { branchName: 'c' } })
  })
})

describe('runsInTaskDir', () => {
  it('restarts agents and terminals on a move, not browsers, editors or a terminal with its own folder', () => {
    expect(runsInTaskDir(tab('a', 'claude'))).toBe(true)
    expect(runsInTaskDir(tab('a', 'claude-chat'))).toBe(true)
    expect(runsInTaskDir(tab('a', 'terminal'))).toBe(true)
    expect(runsInTaskDir({ ...tab('a', 'terminal'), cwd: '/elsewhere' })).toBe(false)
    expect(runsInTaskDir(tab('a', 'browser'))).toBe(false)
    expect(runsInTaskDir(tab('a', 'editor'))).toBe(false)
  })
})

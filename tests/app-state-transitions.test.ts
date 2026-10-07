import { describe, it, expect } from 'vitest'
import {
  createDefaultWindowViewState,
  createMainStream,
  createTaskViewState,
  type PinnedItem,
  type Project,
  type ProjectsData,
  type Tab,
  type Task,
  type TaskViewState,
  type WindowViewState
} from '../src/shared/types'
import { findMainStream, findStreamOfTask, paneTabs, projectTasks, tabsByPane } from '../src/shared/streams'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'
import {
  addTaskInDirectoryData,
  appendProject,
  appendTaskToProject,
  findOrCreateTagId,
  getProjectDir,
  includePendingTags,
  insertTabAt,
  makeTask,
  patchTab,
  removeProjectFromData,
  removeTaskFromData,
  renameTabInData,
  reorderList,
  tabIdsOfTask,
  togglePinnedItemInData
} from '../src/renderer/hooks/appState/projectsData'
import {
  inboxSettled,
  inboxSnoozed,
  inboxUnsnoozed,
  inboxVisited,
  inboxWithEvent
} from '../src/renderer/hooks/appState/inbox'
import {
  forgetRemovedTaskView,
  reassignActiveTabsAfterNoteDelete,
  removeTaskView,
  selectProjectHomeView,
  selectProjectView,
  setProjectExpandedView,
  sidebarForTask,
  toggleId,
  withActiveTab,
  writeSidebarToTask
} from '../src/renderer/hooks/appState/viewState'
import {
  addNoteToRecord,
  deleteNoteFromRecord,
  noteTabIds,
  patchNoteInRecord,
  removeNoteTabs,
  retitleNoteTabs
} from '../src/renderer/hooks/appState/notesData'
import { nextBrowserZoomFactor, nextTerminalZoomDelta } from '../src/renderer/hooks/appState/zoom'

function tab(id: string, extra: Partial<Tab> = {}): Tab {
  return { id, type: 'terminal', title: id, ...extra }
}

function task(id: string, left: Tab[] = [], right: Tab[] = []): Task {
  return fixtureTask({ id, tabs: { left, right }, activeTab: { left: left[0]?.id ?? null, right: right[0]?.id ?? null } })
}

function taskState(t: Task): TaskViewState {
  return createTaskViewState(t)
}

function project(id: string, tasks: Task[], extra: Partial<Project> = {}): Project {
  return { ...fixtureProject({ id, directory: '/d' }), ...extra, streams: [createMainStream(id, tasks)] }
}

const WORKSPACE = { worktreePath: '/wt', branchName: 'b', baseBranch: 'main', relativeProjectPath: '' }

function data(projects: Project[]): ProjectsData {
  return { projects, tags: [], projectOrder: projects.map(p => p.id), pinnedItems: [] }
}

function view(patch: Partial<WindowViewState> = {}): WindowViewState {
  return { ...createDefaultWindowViewState(), ...patch }
}

describe('projectsData', () => {
  it('reorderList moves one element without mutating the input', () => {
    const input = ['a', 'b', 'c', 'd']
    expect(reorderList(input, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorderList(input, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(input).toEqual(['a', 'b', 'c', 'd'])
  })

  it('makeTask starts on its last initial tab and stamps an interaction', () => {
    const t = makeTask('New', [tab('a'), tab('b')])
    expect(t.panes).toHaveLength(1)
    expect(t.panes[0].activeTabId).toBe('b')
    expect(paneTabs(t, 'right')).toEqual([])
    expect(t.mainTabId).toBe('a')
    expect(typeof t.lastInteractedAt).toBe('number')
    expect(t.workspaceDraft).toBeUndefined()
    expect(tabIdsOfTask(task('x', [tab('a')], [tab('z')]))).toEqual(['a', 'z'])
  })

  it('getProjectDir prefers the remote directory', () => {
    const local: Project = fixtureProject({ id: 'p', directory: '/local' })
    expect(getProjectDir(local)).toBe('/local')
    expect(getProjectDir({ ...local, ssh: { host: 'h', remoteDir: '/remote' } as Project['ssh'] })).toBe('/remote')
  })

  it('appendProject and removeProjectFromData keep projectOrder in step', () => {
    const p: Project = fixtureProject({ id: 'p2', directory: '/d' })
    const added = appendProject(data([]), p)
    expect(added.projectOrder).toEqual(['p2'])
    const removed = removeProjectFromData(added, 'p2')
    expect(removed.projects).toEqual([])
    expect(removed.projectOrder).toEqual([])
  })

  it('appendTaskToProject counts the task in lifetime stats', () => {
    const d = data([fixtureProject({ id: 'p', directory: '/d' })])
    const next = appendTaskToProject(d, 'p', task('t1'))
    expect(findMainStream(next.projects[0])!.tasks.map(t => t.id)).toEqual(['t1'])
    expect(next.projects[0].lifetimeStats?.tasksCreated).toBe(1)
    expect(appendTaskToProject(next, 'p', task('t1')).projects[0].streams).toEqual(next.projects[0].streams)
  })

  it('appendTaskToProject gives a task with a worktree its own stream named after it', () => {
    const d = data([fixtureProject({ id: 'p', directory: '/d' })])
    const next = appendTaskToProject(d, 'p', { ...task('t1'), name: 'Fix it' }, { workspace: WORKSPACE, streamId: 's1' })
    const stream = findStreamOfTask(next.projects[0], 't1')!
    expect(stream).toMatchObject({ id: 's1', name: 'Fix it', workspace: WORKSPACE })
    expect(stream.isMain).toBeUndefined()
    expect(findMainStream(next.projects[0])!.tasks).toEqual([])
  })

  it('addTaskInDirectoryData mints a hidden project once and reuses it', () => {
    const first = addTaskInDirectoryData(data([]), 'owner', '/tmp/scratch', task('t1'))
    expect(first.projects).toHaveLength(1)
    expect(first.projects[0]).toMatchObject({ id: 'owner', name: 'scratch', ephemeral: true })
    expect(first.projectOrder).toEqual(['owner'])
    const second = addTaskInDirectoryData(first, 'owner', '/tmp/scratch', task('t2'))
    expect(second.projects).toHaveLength(1)
    expect(projectTasks(second.projects[0]).map(t => t.id).slice(-2)).toEqual(['t1', 't2'])
  })

  it('removeTaskFromData retires a spent hidden project but keeps a normal one', () => {
    const hidden: Project = project('p', [task('t1')], { ephemeral: true })
    const retired = removeTaskFromData(data([hidden]), 'p', 't1')
    expect(retired.projects).toEqual([])
    expect(retired.projectOrder).toEqual([])

    const normal: Project = { ...hidden, ephemeral: undefined }
    const kept = removeTaskFromData(data([normal]), 'p', 't1')
    expect(projectTasks(kept.projects[0])).toEqual([])
  })

  it('removeTaskFromData drops a worktree stream with its last task, never main', () => {
    const p = fixtureProject({ id: 'p', tasks: [{ id: 'm1' }, { id: 'w1', workspace: WORKSPACE }] })
    const withoutWorktreeTask = removeTaskFromData(data([p]), 'p', 'w1').projects[0]
    expect(withoutWorktreeTask.streams.map(s => s.id)).toEqual([findMainStream(p)!.id])
    const withoutMainTask = removeTaskFromData(data([p]), 'p', 'm1').projects[0]
    expect(withoutMainTask.streams).toHaveLength(2)
    expect(findMainStream(withoutMainTask)!.tasks).toEqual([])
  })

  it('tab edits touch only the target tab', () => {
    const other = tab('b')
    const d = data([project('p', [task('t', [tab('a'), other])])])
    const renamed = renameTabInData(d, 'p', 't', 'left', 'a', 'Renamed')
    expect(paneTabs(projectTasks(renamed.projects[0])[0], 'left')[0].title).toBe('Renamed')
    expect(paneTabs(projectTasks(renamed.projects[0])[0], 'left')[1]).toBe(other)
    const patched = patchTab(d, 'p', 't', 'left', 'a', { url: 'http://x' })
    expect(paneTabs(projectTasks(patched.projects[0])[0], 'left')[0].url).toBe('http://x')
  })

  it('insertTabAt clamps the index and is idempotent', () => {
    const d = data([project('p', [task('t', [tab('a')])])])
    const leftIds = (x: ProjectsData) => paneTabs(projectTasks(x.projects[0])[0], 'left').map(t => t.id)
    const once = insertTabAt(d, 'p', 't', 'left', 99, tab('z'))
    expect(leftIds(once)).toEqual(['a', 'z'])
    const twice = insertTabAt(once, 'p', 't', 'left', 0, tab('z'))
    expect(leftIds(twice)).toEqual(['a', 'z'])
    const front = insertTabAt(d, 'p', 't', 'left', -5, tab('z'))
    expect(leftIds(front)).toEqual(['z', 'a'])
  })

  it('includePendingTags folds in only referenced, not-yet-present tags', () => {
    const pending = new Map([['t1', { id: 't1', name: 'one' }], ['t2', { id: 't2', name: 'two' }]])
    const d = data([])
    expect(includePendingTags(d, undefined, pending)).toBe(d)
    expect(includePendingTags(d, ['t1'], pending).tags).toEqual([{ id: 't1', name: 'one' }])
    const withT1 = { ...d, tags: [{ id: 't1', name: 'one' }] }
    expect(includePendingTags(withT1, ['t1'], pending)).toBe(withT1)
  })

  it('findOrCreateTagId matches case-insensitively and ignores blank names', () => {
    const d = { ...data([]), tags: [{ id: 'x', name: 'Backend' }] }
    expect(findOrCreateTagId(d, '  backend ')).toEqual({ data: d, tagId: 'x' })
    expect(findOrCreateTagId(d, '   ')).toEqual({ data: d, tagId: '' })
    const created = findOrCreateTagId(d, 'Frontend')
    expect(created.data.tags.map(t => t.name)).toEqual(['Backend', 'Frontend'])
    expect(created.tagId).toBe(created.data.tags[1].id)
  })

  it('togglePinnedItemInData pins then unpins', () => {
    const item: PinnedItem = { type: 'project', projectId: 'p' }
    const pinned = togglePinnedItemInData(data([]), item)
    expect(pinned.pinnedItems).toHaveLength(1)
    expect(togglePinnedItemInData(pinned, item).pinnedItems).toEqual([])
  })
})

describe('inbox transitions', () => {
  it('an attention event wakes an attention-snooze and undoes a settle', () => {
    const next = inboxWithEvent({ settledAt: 1, snoozeUntilAttention: true, snoozedAt: 2 }, 10, 'attention', false)
    expect(next).toEqual({ eventAt: 10, attentionAt: 10 })
  })

  it('a plain event leaves an attention-snooze alone, and a watched one is read', () => {
    const next = inboxWithEvent({ snoozeUntilAttention: true, snoozedAt: 2 }, 10, 'event', true)
    expect(next).toEqual({ snoozeUntilAttention: true, snoozedAt: 2, eventAt: 10, visitedAt: 10 })
  })

  it('visiting clears forced unread; settling clears snooze too', () => {
    expect(inboxVisited({ forcedUnread: true }, 5)).toEqual({ visitedAt: 5 })
    expect(inboxSettled({ forcedUnread: true, snoozedUntil: 9, snoozedAt: 1 }, 5)).toEqual({ settledAt: 5, visitedAt: 5 })
  })

  it('snoozing switches between timed and until-attention', () => {
    const timed = inboxSnoozed({ snoozeUntilAttention: true, settledAt: 1 }, 5, { until: 100 })
    expect(timed).toEqual({ snoozedAt: 5, visitedAt: 5, snoozedUntil: 100 })
    const attention = inboxSnoozed(timed, 6, { untilAttention: true })
    expect(attention).toEqual({ snoozedAt: 6, visitedAt: 6, snoozeUntilAttention: true })
    expect(inboxUnsnoozed(attention)).toEqual({ visitedAt: 6 })
  })
})

describe('view state transitions', () => {
  it('toggleId and setProjectExpandedView', () => {
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b'])
    const prev = view({ expandedProjectIds: ['p'] })
    expect(setProjectExpandedView(prev, 'p', true)).toBe(prev)
    expect(setProjectExpandedView(prev, 'p', false).expandedProjectIds).toEqual([])
  })

  it('selectProjectView restores a still-existing lastTaskId and expands the project', () => {
    const p: Project = fixtureProject({ id: 'p', lastTaskId: 't', tasks: [{ id: 't' }] })
    const next = selectProjectView(view(), 'p', p)
    expect(next).toMatchObject({ selectedProjectId: 'p', selectedTaskId: 't', expandedProjectIds: ['p'] })
    const stale = selectProjectView(view(), 'p', {
      ...p,
      streams: p.streams.map(s => ({ ...s, lastTaskId: 'gone' }))
    })
    expect(stale.selectedTaskId).toBeNull()
    expect(selectProjectView(next, null, null)).toMatchObject({ selectedProjectId: null, selectedTaskId: null })
  })

  it('selectProjectHomeView selects the project with no task', () => {
    const next = selectProjectHomeView(view({ selectedTaskId: 't' }), 'p')
    expect(next).toMatchObject({ selectedProjectId: 'p', selectedTaskId: null, expandedProjectIds: ['p'] })
  })

  it('removeTaskView only clears the project selection when the owner retired', () => {
    const prev = view({ selectedProjectId: 'p', selectedTaskId: 't', taskStates: { t: withActiveTab(taskState(task('t')), 'left', null) } })
    const kept = removeTaskView(prev, 'p', 't', false)
    expect(kept).toMatchObject({ selectedProjectId: 'p', selectedTaskId: null, taskStates: {} })
    expect(removeTaskView(prev, 'p', 't', true).selectedProjectId).toBeNull()
  })

  it('forgetRemovedTaskView is a no-op for a task this window never saw', () => {
    const prev = view({ selectedTaskId: 'other' })
    expect(forgetRemovedTaskView(prev, 'unknown')).toBe(prev)
  })

  it('writeSidebarToTask writes through to the current task', () => {
    const t = task('t', [tab('a')])
    const prev = view({ selectedTaskId: 't' })
    const next = writeSidebarToTask(prev, t, { fileBrowserOpen: true })
    expect(next.fileBrowserOpen).toBe(true)
    expect(next.taskStates.t.fileBrowserOpen).toBe(true)
    expect(writeSidebarToTask(view(), null, { fileBrowserActiveTab: 'notes' }).taskStates).toEqual({})
  })

  it('sidebarForTask prefers saved state, then the window', () => {
    const base = view({ fileBrowserOpen: false, fileBrowserActiveTab: 'files' })
    expect(sidebarForTask(base, task('t'))).toEqual({ fileBrowserOpen: false, fileBrowserActiveTab: 'files' })
    const saved = { ...base, taskStates: { t: { ...withActiveTab(taskState(task('t')), 'left', null), fileBrowserOpen: true } } }
    expect(sidebarForTask(saved, task('t')).fileBrowserOpen).toBe(true)
  })

  it('reassignActiveTabsAfterNoteDelete moves off the doomed note tab', () => {
    const noteTab = tab('n', { type: 'note', noteId: 'note1' })
    const t = task('t', [tab('a'), noteTab])
    const p = project('p', [t])
    const next = reassignActiveTabsAfterNoteDelete(view({ taskStates: { t: withActiveTab(taskState(t), 'left', 'n') } }), p, 'note1')
    expect(next.taskStates.t.activeTab.left).toBe('a')
  })
})

describe('notes transitions', () => {
  const note = { id: 'n1', name: 'N', content: '', createdAt: 1, updatedAt: 1 }

  it('a replayed create does not duplicate', () => {
    const once = addNoteToRecord({}, 'p', note)
    expect(addNoteToRecord(once, 'p', note)).toBe(once)
  })

  it('edits and deletes of a missing note are dropped', () => {
    const empty = {}
    expect(patchNoteInRecord(empty, 'p', 'n1', { content: 'x' })).toBe(empty)
    expect(deleteNoteFromRecord(empty, 'p', 'n1')).toBe(empty)
    const record = { p: [note] }
    expect(patchNoteInRecord(record, 'p', 'n1', { content: 'x', updatedAt: 2 }).p[0]).toMatchObject({ content: 'x', updatedAt: 2 })
    expect(deleteNoteFromRecord(record, 'p', 'n1').p).toEqual([])
  })

  it('note tabs are found, retitled and removed together', () => {
    const noteTab = tab('nt', { type: 'note', noteId: 'n1', title: 'old' })
    const p = project('p', [task('t', [tab('a')], [noteTab])])
    expect(noteTabIds(p, 'n1')).toEqual(['nt'])
    const d = data([p])
    expect(paneTabs(projectTasks(retitleNoteTabs(d, 'p', 'n1', 'new').projects[0])[0], 'right')[0].title).toBe('new')
    // The emptied right pane closes.
    const removed = projectTasks(removeNoteTabs(d, 'p', 'n1').projects[0])[0]
    expect(tabsByPane(removed)).toEqual({ left: [tab('a')], right: [] })
    expect(removed.panes).toHaveLength(1)
  })
})

describe('zoom', () => {
  it('terminal zoom steps by 2 within the 6..48 effective range', () => {
    expect(nextTerminalZoomDelta(0, 'in', 14)).toBe(2)
    expect(nextTerminalZoomDelta(34, 'in', 14)).toBe(34)
    expect(nextTerminalZoomDelta(-8, 'out', 14)).toBe(-8)
    expect(nextTerminalZoomDelta(10, 'reset', 14)).toBe(0)
  })

  it('browser zoom steps by 0.1 within 0.3..3.0 without float drift', () => {
    expect(nextBrowserZoomFactor(1.0, 'in')).toBe(1.1)
    expect(nextBrowserZoomFactor(0.3, 'out')).toBe(0.3)
    expect(nextBrowserZoomFactor(3.0, 'in')).toBe(3.0)
    expect(nextBrowserZoomFactor(2.2, 'reset')).toBe(1.0)
  })
})

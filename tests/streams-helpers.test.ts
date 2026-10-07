import { describe, expect, it } from 'vitest'
import type { Tab } from '../src/shared/types'
import {
  mapTaskTabs,
  paneTabs,
  projectLastTaskId,
  removeTaskFromProject,
  resolveMainTabId,
  taskWorkspace,
  withLastTask,
  withTabsByPane,
  workspaceReleasedBy
} from '../src/shared/streams'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

const tab = (id: string, type: Tab['type'] = 'terminal'): Tab => ({ id, type, title: id })
const workspace = { worktreePath: '/repo/.worktrees/x', branchName: 'x', baseBranch: 'main', relativeProjectPath: '' }

describe('task panes', () => {
  it('closes an emptied left pane and lets the right one take the row', () => {
    const task = fixtureTask({ id: 't', tabs: { left: [tab('a')], right: [tab('b'), tab('c')] }, activeTab: { right: 'b' } })
    const next = withTabsByPane(task, { left: [], right: paneTabs(task, 'right') })
    expect(next.panes).toEqual([{ tabs: [tab('b'), tab('c')], activeTabId: 'b', width: 1 }])
    expect(paneTabs(next, 'left').map(t => t.id)).toEqual(['b', 'c'])
  })

  it('opens a second pane at half width and keeps the active tab', () => {
    const task = fixtureTask({ id: 't', tabs: { left: [tab('a'), tab('b')] }, activeTab: { left: 'a' } })
    const next = withTabsByPane(task, { left: [tab('a')], right: [tab('b')] })
    expect(next.panes).toEqual([
      { tabs: [tab('a')], activeTabId: 'a', width: 0.5 },
      { tabs: [tab('b')], activeTabId: 'b', width: 0.5 }
    ])
  })

  it('makes the first agent tab the main tab, and keeps it while it stays', () => {
    expect(resolveMainTabId([tab('t'), tab('c', 'claude-chat')])).toBe('c')
    expect(resolveMainTabId([tab('t'), tab('b', 'browser')])).toBe('t')
    expect(resolveMainTabId([tab('b', 'browser')])).toBeUndefined()
    expect(resolveMainTabId([tab('t'), tab('c', 'codex')], 't')).toBe('t')
  })

  it('mapTaskTabs drops emptied panes, rescales widths and moves the main tab', () => {
    const task = fixtureTask({ id: 't', tabs: { left: [tab('c', 'claude')], right: [tab('n', 'note')] } })
    expect(task.mainTabId).toBe('c')
    const next = mapTaskTabs(task, tabs => tabs.filter(t => t.id !== 'c'))
    expect(next.panes).toEqual([{ tabs: [tab('n', 'note')], activeTabId: 'n', width: 1 }])
    expect(next.mainTabId).toBeUndefined()
    expect(mapTaskTabs(task, tabs => tabs)).toBe(task)
  })
})

describe('streams', () => {
  const project = () => fixtureProject({
    id: 'p',
    tasks: [{ id: 'plain', tabs: { left: [tab('a')] } }, { id: 'ws', workspace, tabs: { left: [tab('b')] } }]
  })

  it('finds a task’s worktree on its stream', () => {
    expect(taskWorkspace(project(), 'ws')).toEqual(workspace)
    expect(taskWorkspace(project(), 'plain')).toBeUndefined()
  })

  it('releases the worktree only with the stream’s last task', () => {
    const p = project()
    expect(workspaceReleasedBy(p, 'ws')).toEqual(workspace)
    p.streams[1].tasks.push(fixtureTask({ id: 'ws2' }))
    expect(workspaceReleasedBy(p, 'ws')).toBeUndefined()
  })

  it('removes an emptied stream but never main', () => {
    const p = withLastTask(project(), 'ws')
    const withoutWs = removeTaskFromProject(p, 'ws')
    expect(withoutWs.streams.map(s => s.id)).toEqual(['main-p'])
    expect(withoutWs.lastStreamId).toBeUndefined()
    const withoutPlain = removeTaskFromProject(withoutWs, 'plain')
    expect(withoutPlain.streams).toEqual([{ id: 'main-p', name: 'main', isMain: true, tasks: [] }])
  })

  it('remembers the last task through its stream', () => {
    const p = withLastTask(project(), 'ws')
    expect(p.lastStreamId).toBe('stream-ws')
    expect(projectLastTaskId(p)).toBe('ws')
    expect(withLastTask(p, 'ws')).toBe(p)
    expect(projectLastTaskId(removeTaskFromProject(p, 'ws'))).toBeUndefined()
  })
})

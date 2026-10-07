import { describe, expect, it } from 'vitest'
import type { Tab } from '../src/shared/types'
import {
  mapTaskTabs,
  projectLastTaskId,
  removeTaskFromProject,
  resolveMainTabId,
  taskWorkspace,
  withLastTask,
  currentStreamId,
  planTaskMove,
  streamDirectory,
  tabSpawnDir
} from '../src/shared/streams'
import { retargetPath } from '../src/shared/workspace-path'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

const tab = (id: string, type: Tab['type'] = 'terminal'): Tab => ({ id, type, title: id })
const workspace = { worktreePath: '/repo/.worktrees/x', branchName: 'x', baseBranch: 'main', relativeProjectPath: '' }

describe('task panes', () => {
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

  it('keeps an emptied stream, worktree and all, and main', () => {
    const p = withLastTask(project(), 'ws')
    const withoutWs = removeTaskFromProject(p, 'ws')
    expect(withoutWs.streams.map(s => s.id)).toEqual(['main-p', 'stream-ws'])
    expect(withoutWs.streams[1]).toMatchObject({ workspace, tasks: [] })
    expect(withoutWs.streams[1].lastTaskId).toBeUndefined()
    const withoutPlain = removeTaskFromProject(withoutWs, 'plain')
    expect(withoutPlain.streams[0]).toEqual({ id: 'main-p', name: 'main', isMain: true, tasks: [] })
  })

  it('picks the current stream: the selected task’s, else the last one, else main', () => {
    const p = project()
    expect(currentStreamId(p, 'ws')).toBe('stream-ws')
    expect(currentStreamId(p, null)).toBe('main-p')
    expect(currentStreamId(withLastTask(p, 'ws'), 'gone')).toBe('stream-ws')
    expect(currentStreamId(withLastTask(p, 'ws'), 'plain')).toBe('main-p')
  })

  it('names a stream’s directory: its worktree, else the project folder', () => {
    const p = { ...project(), directory: '/repo/app' }
    expect(streamDirectory(p, p.streams[1])).toBe('/repo/.worktrees/x')
    expect(streamDirectory(p, { ...p.streams[1], workspace: { ...workspace, relativeProjectPath: 'app' } })).toBe('/repo/.worktrees/x/app')
    expect(streamDirectory(p, p.streams[0])).toBe('/repo/app')
    expect(streamDirectory({ ...p, ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/srv' } }, p.streams[0])).toBe('/srv')
  })

  it('remembers the last task through its stream', () => {
    const p = withLastTask(project(), 'ws')
    expect(p.lastStreamId).toBe('stream-ws')
    expect(projectLastTaskId(p)).toBe('ws')
    expect(withLastTask(p, 'ws')).toBe(p)
    expect(projectLastTaskId(removeTaskFromProject(p, 'ws'))).toBeUndefined()
  })
})

describe('task moves', () => {
  it('re-bases a path inside the old directory, and nothing else', () => {
    expect(retargetPath('/repo/src', '/repo', '/repo/.worktrees/x')).toBe('/repo/.worktrees/x/src')
    expect(retargetPath('/repo', '/repo/', '/wt')).toBe('/wt')
    expect(retargetPath('/repository/src', '/repo', '/wt')).toBeNull()
    expect(retargetPath('/elsewhere', '/repo', '/wt')).toBeNull()
    expect(retargetPath('C:\\repo\\src', 'C:\\repo', 'C:\\wt')).toBe('C:\\wt\\src')
  })

  it('plans the session copies, the terminals that follow and the restarts', () => {
    const task = fixtureTask({
      id: 't',
      tabs: {
        left: [
          { id: 'cli', type: 'claude', title: 'Claude Code', sessionId: 's-cli' },
          { id: 'chat', type: 'claude-chat', title: 'Claude', sessionId: 's-chat' },
          { id: 'pi', type: 'pi', title: 'Pi', sessionId: 's-pi' },
          { id: 'codex', type: 'codex', title: 'Codex', sessionId: 's-codex' },
          tab('sh'),
          { id: 'sub', type: 'terminal', title: 'src', cwd: '/repo/src' },
          { id: 'out', type: 'terminal', title: 'tmp', cwd: '/tmp' },
          { id: 'ed', type: 'editor', title: 'a.ts', filePath: 'src/a.ts' }
        ]
      }
    })
    const plan = planTaskMove(task, '/repo', '/wt')
    expect(plan.sessions).toEqual([
      { kind: 'claude', sessionId: 's-cli' },
      { kind: 'claude', sessionId: 's-chat' },
      { kind: 'pi', sessionId: 's-pi' }
    ])
    expect(plan.cwdMoves).toEqual([{ tabId: 'sub', cwd: '/wt/src' }])
    expect(plan.restartTabIds).toEqual(['cli', 'chat', 'pi', 'codex', 'sh', 'sub'])
  })

  it('keys a tab body on the directory its process runs in', () => {
    expect(tabSpawnDir(tab('sh'), '/wt')).toBe('/wt')
    expect(tabSpawnDir({ ...tab('sub'), cwd: '/wt/src' }, '/wt')).toBe('/wt/src')
    expect(tabSpawnDir(tab('c', 'claude-chat'), '/wt')).toBe('/wt')
    expect(tabSpawnDir(tab('e', 'editor'), '/wt')).toBeNull()
  })
})

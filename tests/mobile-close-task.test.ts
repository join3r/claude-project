import { describe, expect, it } from 'vitest'
import { closeTask, findClosableTab, removeTabFromData, type CloseTaskDeps } from '../src/main/mobile/close-task'
import { type ProjectsData, type Stream } from '../src/shared/types'
import { findTaskInProject, removeTaskFromProject } from '../src/shared/streams'
import { fixtureProject, fixtureTask, type FixtureTask, paneTabsAt } from './helpers/streams-fixtures'

const workspace = { worktreePath: '/src/api/.worktrees/fix', branchName: 'fix', baseBranch: 'main', relativeProjectPath: '' }

/** `t1` with a `workspace` sits alone in a worktree stream; without one, in `main`. */
function data(task: Partial<FixtureTask> = {}, hidden = false, streams: Stream[] = []): ProjectsData {
  return {
    projects: [fixtureProject({
      id: 'p1', name: 'api', directory: '/src/api', hideFromMobile: hidden || undefined,
      tasks: [{
        id: 't1', name: 'fix',
        tabs: {
          left: [{ id: 'tab1', type: 'claude-chat', title: 'Claude', sessionId: 's1' }, { id: 'ed1', type: 'editor', title: 'a.ts' }],
          right: [{ id: 'tab2', type: 'terminal', title: 'zsh' }]
        },
        activeTab: { left: 'ed1', right: 'tab2' },
        ...task
      }],
      streams
    })],
    tags: [], projectOrder: ['p1'], pinnedItems: []
  }
}

/** A worktree stream holding `t2` and `t3`. */
function sharedStream(): Stream {
  return { id: 's-fix', name: 'fix', workspace, tasks: [fixtureTask({ id: 't2' }), fixtureTask({ id: 't3' })] }
}

function deps(projects: ProjectsData, options: { dirty?: string[] } = {}) {
  const calls: string[] = []
  const d: CloseTaskDeps = {
    peek: () => projects,
    dirtyTabIds: () => options.dirty ?? [],
    removeTask: async (_p, task) => { calls.push(`remove ${task.id}`) }
  }
  return { d, calls }
}

describe('closeTask (SPEC.md §8.7)', () => {
  it('removes a plain task', async () => {
    const { d, calls } = deps(data())
    expect(await closeTask(d, { taskId: 't1' })).toEqual({ ok: true, result: { closed: true } })
    expect(calls).toEqual(['remove t1'])
  })

  it('refuses unknown and hidden tasks', async () => {
    expect(await closeTask(deps(data()).d, { taskId: 'nope' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await closeTask(deps(data({}, true)).d, { taskId: 't1' })).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('reports unsaved editors until they are discarded', async () => {
    const { d, calls } = deps(data({ workspace }), { dirty: ['ed1'] })
    expect(await closeTask(d, { taskId: 't1' })).toEqual({ ok: true, result: { closed: false, blocker: 'unsaved' } })
    expect(calls).toEqual([])
    expect(await closeTask(d, { taskId: 't1', discardUnsaved: true })).toEqual({ ok: true, result: { closed: true } })
    expect(calls).toEqual(['remove t1'])
  })

  it('leaves the worktree to its stream, even with the last task of it', async () => {
    const { d, calls } = deps(data({}, false, [sharedStream()]))
    expect(await closeTask(d, { taskId: 't2' })).toEqual({ ok: true, result: { closed: true } })
    expect(calls).toEqual(['remove t2'])
    // The stream outlives its tasks: removing both leaves it, worktree and all.
    let project = removeTaskFromProject(data({}, false, [sharedStream()]).projects[0], 't2')
    project = removeTaskFromProject(project, 't3')
    expect(project.streams.find(s => s.id === 's-fix')).toMatchObject({ workspace, tasks: [] })
  })
})

describe('tab.close helpers (SPEC.md §8.8)', () => {
  it('finds only tabs the phone can see', () => {
    expect(findClosableTab(data(), 'tab2')?.tab.id).toBe('tab2')
    // The task's main tab (its agent) closes only with the task.
    expect(findClosableTab(data(), 'tab1')).toBeNull()
    expect(findClosableTab(data(), 'ed1')).toBeNull()
    expect(findClosableTab(data({}, true), 'tab2')).toBeNull()
    expect(findClosableTab(data(), 'nope')).toBeNull()
  })

  it('never drops the main tab', () => {
    const before = data()
    expect(removeTabFromData(before, 't1', 'tab1').projects[0]).toBe(before.projects[0])
  })

  it('drops the tab and moves the active tab of its pane', () => {
    const next = removeTabFromData(data(), 't1', 'tab2')
    const task = findTaskInProject(next.projects[0], 't1')!
    // The emptied right pane closes; the left one keeps its active tab.
    expect(paneTabsAt(task, 1)).toEqual([])
    expect(task.panes.map(p => p.activeTabId)).toEqual(['ed1'])
    const left = findTaskInProject(removeTabFromData(data(), 't1', 'ed1').projects[0], 't1')!
    expect(left.panes.map(p => p.activeTabId)).toEqual(['tab1', 'tab2'])
  })
})

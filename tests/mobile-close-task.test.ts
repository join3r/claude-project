import { describe, expect, it } from 'vitest'
import { closeTask, findClosableTab, removeTabFromData, type CloseTaskDeps } from '../src/main/mobile/close-task'
import { type ProjectsData, type Stream, type WorkspaceDeleteResult } from '../src/shared/types'
import { findTaskInProject, paneTabs, removeTaskFromProject } from '../src/shared/streams'
import { fixtureProject, fixtureTask, type FixtureTask } from './helpers/streams-fixtures'

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

function deps(projects: ProjectsData, options: { dirty?: string[]; check?: WorkspaceDeleteResult | Error; force?: WorkspaceDeleteResult } = {}) {
  const calls: string[] = []
  const d: CloseTaskDeps = {
    peek: () => projects,
    dirtyTabIds: () => options.dirty ?? [],
    checkWorkspace: async () => {
      calls.push('check')
      if (options.check instanceof Error) throw options.check
      return options.check ?? { status: 'ok' }
    },
    forceDeleteWorkspace: async (_p, _t, keepBranch) => {
      calls.push(`force keepBranch=${keepBranch}`)
      return options.force ?? { status: 'ok' }
    },
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
    expect(calls).toEqual(['check', 'remove t1'])
  })

  it('reports uncommitted or unmerged work in a workspace, leaving the task', async () => {
    const { d, calls } = deps(data({ workspace }), { check: { status: 'uncommitted-and-unmerged', baseBranch: 'main' } })
    expect(await closeTask(d, { taskId: 't1' })).toEqual({
      ok: true, result: { closed: false, blocker: 'uncommitted-and-unmerged', branch: 'fix', baseBranch: 'main' }
    })
    expect(calls).toEqual(['check'])
  })

  it('reports a pre-flight that failed or threw as check-failed', async () => {
    expect(await closeTask(deps(data({ workspace }), { check: new Error('ssh down') }).d, { taskId: 't1' })).toEqual({
      ok: true, result: { closed: false, blocker: 'check-failed', branch: 'fix', baseBranch: 'main', message: 'ssh down' }
    })
  })

  it('removes the tabs before forcing the worktree out, keeping the branch when asked', async () => {
    const { d, calls } = deps(data({ workspace }))
    expect(await closeTask(d, { taskId: 't1', discardWorkspace: true, keepBranch: true })).toEqual({ ok: true, result: { closed: true } })
    expect(calls).toEqual(['remove t1', 'force keepBranch=true'])
  })

  it('closes with a warning when the worktree stays on disk', async () => {
    const { d } = deps(data({ workspace }), { force: { status: 'invalid-worktree', reason: 'not a worktree' } })
    expect(await closeTask(d, { taskId: 't1', discardWorkspace: true })).toEqual({ ok: true, result: { closed: true, warning: 'not a worktree' } })
    const invalid = deps(data({ workspace }), { check: { status: 'invalid-worktree', reason: 'left on disk' } })
    expect(await closeTask(invalid.d, { taskId: 't1' })).toEqual({ ok: true, result: { closed: true, warning: 'left on disk' } })
    expect(invalid.calls).toEqual(['check', 'remove t1'])
  })

  it('leaves the worktree to the other tasks of its stream, and takes it with the last one', async () => {
    const shared = deps(data({}, false, [sharedStream()]), { dirty: [] })
    // Neither a pre-flight nor a forced removal: the worktree stays for t3.
    expect(await closeTask(shared.d, { taskId: 't2' })).toEqual({ ok: true, result: { closed: true } })
    expect(await closeTask(shared.d, { taskId: 't2', discardWorkspace: true })).toEqual({ ok: true, result: { closed: true } })
    expect(shared.calls).toEqual(['remove t2', 'remove t2'])

    const afterT2 = data({}, false, [sharedStream()])
    afterT2.projects[0] = removeTaskFromProject(afterT2.projects[0], 't2')
    const last = deps(afterT2, { check: { status: 'uncommitted', baseBranch: 'main' } })
    expect(await closeTask(last.d, { taskId: 't3' })).toEqual({
      ok: true, result: { closed: false, blocker: 'uncommitted', branch: 'fix', baseBranch: 'main' }
    })
    expect(await closeTask(last.d, { taskId: 't3', discardWorkspace: true })).toEqual({ ok: true, result: { closed: true } })
    expect(last.calls).toEqual(['check', 'remove t3', 'force keepBranch=false'])
  })
})

describe('tab.close helpers (SPEC.md §8.8)', () => {
  it('finds only tabs the phone can see', () => {
    expect(findClosableTab(data(), 'tab2')?.tab.id).toBe('tab2')
    expect(findClosableTab(data(), 'ed1')).toBeNull()
    expect(findClosableTab(data({}, true), 'tab2')).toBeNull()
    expect(findClosableTab(data(), 'nope')).toBeNull()
  })

  it('drops the tab and moves the active tab of its pane', () => {
    const next = removeTabFromData(data(), 't1', 'tab2')
    const task = findTaskInProject(next.projects[0], 't1')!
    // The emptied right pane closes; the left one keeps its active tab.
    expect(paneTabs(task, 'right')).toEqual([])
    expect(task.panes.map(p => p.activeTabId)).toEqual(['ed1'])
    const left = findTaskInProject(removeTabFromData(data(), 't1', 'ed1').projects[0], 't1')!
    expect(left.panes.map(p => p.activeTabId)).toEqual(['tab1', 'tab2'])
  })
})

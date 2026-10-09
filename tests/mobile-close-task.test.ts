import { describe, expect, it } from 'vitest'
import { closeTask, findClosableTab, landTask, landingErrorMessage, removeTabFromData, type CloseTaskDeps, type PhoneLanding } from '../src/main/mobile/close-task'
import { type ProjectsData, type Stream, type TaskLanding, type TaskLandingResult } from '../src/shared/types'
import { findTaskInProject, mapTaskInProject, removeTaskFromProject } from '../src/shared/streams'
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

function deps(projects: ProjectsData, options: { dirty?: string[]; working?: string[] } = {}) {
  const calls: string[] = []
  const d: CloseTaskDeps = {
    peek: () => projects,
    dirtyTabIds: () => options.dirty ?? [],
    statusOf: (tabId) => (options.working?.includes(tabId) ? 'working' : null),
    removeTask: async (_p, task) => { calls.push(`remove ${task.id}`) }
  }
  return { d, calls }
}

describe('closeTask (SPEC.md §8.7)', () => {
  it('archives a plain task', async () => {
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

  it('reports a working agent first, then unsaved editors, as the sidebar asks', async () => {
    const { d, calls } = deps(data(), { dirty: ['ed1'], working: ['tab1'] })
    expect(await closeTask(d, { taskId: 't1' })).toEqual({ ok: true, result: { closed: false, blocker: 'working' } })
    expect(await closeTask(d, { taskId: 't1', discardUnsaved: true })).toEqual({ ok: true, result: { closed: false, blocker: 'working' } })
    expect(await closeTask(d, { taskId: 't1', stopWorking: true })).toEqual({ ok: true, result: { closed: false, blocker: 'unsaved' } })
    expect(calls).toEqual([])
    expect(await closeTask(d, { taskId: 't1', stopWorking: true, discardUnsaved: true })).toEqual({ ok: true, result: { closed: true } })
    expect(calls).toEqual(['remove t1'])
  })

  it('does not count a busy terminal as working', async () => {
    const { d, calls } = deps(data(), { working: ['tab2'] })
    expect(await closeTask(d, { taskId: 't1' })).toEqual({ ok: true, result: { closed: true } })
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

const own = { worktreePath: '/src/api/.worktrees/fix--t1', branchName: 'fix--t1', baseBranch: 'fix', relativeProjectPath: '' }

/**
 * A fake landing manager over mutable projects: `landTask` answers `next`, setting
 * `Task.landing` for a stop and archiving (dropping the task) for a close that lands,
 * as main's does.
 */
function landingEnv(next: TaskLandingResult, landing?: TaskLanding) {
  let projects = data({ workspace, ownWorkspace: own, ...(landing ? { landing } : {}) })
  const calls: string[] = []
  const setLanding = (value: TaskLanding | null) => {
    projects = {
      ...projects,
      projects: projects.projects.map(p => mapTaskInProject(p, 't1', t => {
        const { landing: _old, ...rest } = t
        return value ? { ...rest, landing: value } : rest
      }))
    }
  }
  const settle = (result: TaskLandingResult, intent: 'close' | 'update' = 'close'): TaskLandingResult => {
    if (result.status === 'conflict') setLanding({ state: 'conflict', intent, files: result.files })
    else if (result.status === 'blocked') setLanding({ state: 'blocked', intent, files: result.files, message: result.message })
    else if (result.status === 'fixing') setLanding({ state: 'fixing', intent, files: ['a.ts'] })
    else if ((result.status === 'landed' || result.status === 'nothing') && intent === 'close') {
      projects = { ...projects, projects: projects.projects.map(p => removeTaskFromProject(p, 't1')) }
    } else setLanding(null)
    return result
  }
  const landingCalls: PhoneLanding = {
    landTask: async (projectId, taskId) => { calls.push(`land ${projectId}/${taskId}`); return settle(next) },
    fixWithAgent: async (_p, taskId) => { calls.push(`fix ${taskId}`); return settle(next) },
    abortLanding: async (_p, taskId) => { calls.push(`abort ${taskId}`); return settle(next) },
    retryLanding: async (_p, taskId) => { calls.push(`retry ${taskId}`); return settle(next) }
  }
  const working = new Set<string>()
  const d: CloseTaskDeps = {
    peek: () => projects,
    dirtyTabIds: () => [],
    statusOf: (tabId) => (working.has(tabId) ? 'working' : null),
    removeTask: async (_p, task) => { calls.push(`remove ${task.id}`) },
    landing: landingCalls,
    stopTabs: async (_p, task) => { calls.push(`stop ${task.id}`); working.clear() }
  }
  return { d, calls, working, landing: landingCalls, peek: () => projects }
}

describe('closeTask on a task with its own worktree (SPEC.md §8.7, version 3)', () => {
  it('lands it instead of archiving; main archives what landed', async () => {
    const env = landingEnv({ status: 'landed' })
    expect(await closeTask(env.d, { taskId: 't1' })).toEqual({ ok: true, result: { closed: true } })
    expect(env.calls).toEqual(['land p1/t1'])
    const nothing = landingEnv({ status: 'nothing' })
    expect(await closeTask(nothing.d, { taskId: 't1' })).toEqual({ ok: true, result: { closed: true } })
  })

  it('stays open on a conflict and answers with the landing', async () => {
    const env = landingEnv({ status: 'conflict', files: ['src/a.ts', 'src/b.ts'] })
    expect(await closeTask(env.d, { taskId: 't1' })).toEqual({
      ok: true,
      result: { closed: false, landing: { state: 'conflict', intent: 'close', files: ['src/a.ts', 'src/b.ts'], fileCount: 2 } }
    })
    expect(env.calls).toEqual(['land p1/t1'])
  })

  it('tells a version 2 phone why in an error, since it knows no landing', async () => {
    const conflict = landingEnv({ status: 'conflict', files: ['src/a.ts', 'src/b.ts'] })
    expect(await closeTask(conflict.d, { taskId: 't1' }, { version: 2 })).toEqual({
      ok: false, code: 'internal', message: 'Conflicts with fix in 2 files. Open the task on the desktop to resolve them.'
    })
    const blocked = landingEnv({ status: 'blocked', files: ['a.txt'], message: 'error: Your local changes would be overwritten' })
    expect(await closeTask(blocked.d, { taskId: 't1' }, { version: 2 })).toMatchObject({
      ok: false, code: 'internal', message: 'fix has local changes in 1 file. Commit or stash them on the desktop, then close the task again.'
    })
  })

  it('keeps the blockers, and stops a working agent before landing when asked', async () => {
    const env = landingEnv({ status: 'landed' })
    env.working.add('tab1')
    expect(await closeTask(env.d, { taskId: 't1' })).toEqual({ ok: true, result: { closed: false, blocker: 'working' } })
    expect(env.calls).toEqual([])
    expect(await closeTask(env.d, { taskId: 't1', stopWorking: true })).toEqual({ ok: true, result: { closed: true } })
    expect(env.calls).toEqual(['stop t1', 'land p1/t1'])
  })

  it('reports a landing refused for a working agent as the working blocker, and a failure as internal', async () => {
    expect(await closeTask(landingEnv({ status: 'working' }).d, { taskId: 't1' })).toEqual({ ok: true, result: { closed: false, blocker: 'working' } })
    expect(await closeTask(landingEnv({ status: 'failed', error: 'This task is already landing' }).d, { taskId: 't1' }))
      .toEqual({ ok: false, code: 'internal', message: 'This task is already landing' })
  })

  it('archives a task sharing its stream\'s worktree as before', async () => {
    const env = landingEnv({ status: 'landed' })
    const shared = data({}, false, [sharedStream()])
    const d: CloseTaskDeps = { ...env.d, peek: () => shared }
    expect(await closeTask(d, { taskId: 't2' })).toEqual({ ok: true, result: { closed: true } })
    expect(env.calls).toEqual(['remove t2'])
  })

  it('cuts a long file list and message to the wire caps', () => {
    const files = Array.from({ length: 30 }, (_, i) => `f${i}.ts`)
    expect(landingErrorMessage({ state: 'conflict', files }, '0.5.0')).toBe('Conflicts with 0.5.0 in 30 files. Open the task on the desktop to resolve them.')
  })
})

describe('landTask (SPEC.md §8.15)', () => {
  it('maps each action to the landing manager', async () => {
    const fix = landingEnv({ status: 'fixing' }, { state: 'conflict', files: ['a.ts'] })
    expect(await landTask({ peek: fix.peek, landing: fix.landing }, { taskId: 't1', action: 'fix-with-agent' })).toEqual({
      ok: true, result: { status: 'fixing', landing: { state: 'fixing', intent: 'close', files: ['a.ts'], fileCount: 1 } }
    })
    const abort = landingEnv({ status: 'aborted' }, { state: 'conflict', files: ['a.ts'] })
    expect(await landTask({ peek: abort.peek, landing: abort.landing }, { taskId: 't1', action: 'abort' })).toEqual({ ok: true, result: { status: 'aborted' } })
    expect(findTaskInProject(abort.peek().projects[0], 't1')?.landing).toBeUndefined()
    const retry = landingEnv({ status: 'landed' }, { state: 'blocked', files: ['a.ts'] })
    expect(await landTask({ peek: retry.peek, landing: retry.landing }, { taskId: 't1', action: 'retry' })).toEqual({ ok: true, result: { status: 'landed', closed: true } })
    expect([...fix.calls, ...abort.calls, ...retry.calls]).toEqual(['fix t1', 'abort t1', 'retry t1'])
  })

  it('answers a retry that stops again with the landing, and a failure as internal', async () => {
    const env = landingEnv({ status: 'conflict', files: ['x.ts'] }, { state: 'conflict', files: ['x.ts'] })
    expect(await landTask({ peek: env.peek, landing: env.landing }, { taskId: 't1', action: 'retry' })).toMatchObject({
      ok: true, result: { status: 'conflict', landing: { state: 'conflict', files: ['x.ts'] } }
    })
    const failed = landingEnv({ status: 'failed', error: 'Nothing to retry' })
    expect(await landTask({ peek: failed.peek, landing: failed.landing }, { taskId: 't1', action: 'retry' })).toEqual({ ok: false, code: 'internal', message: 'Nothing to retry' })
  })

  it('refuses unknown tasks and tasks without a worktree of their own', async () => {
    const env = landingEnv({ status: 'aborted' })
    expect(await landTask({ peek: env.peek, landing: env.landing }, { taskId: 'nope', action: 'abort' })).toMatchObject({ ok: false, code: 'not-found' })
    const shared = data({}, false, [sharedStream()])
    expect(await landTask({ peek: () => shared, landing: env.landing }, { taskId: 't2', action: 'abort' })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(env.calls).toEqual([])
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

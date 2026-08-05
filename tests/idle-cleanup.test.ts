import { describe, expect, it, vi } from 'vitest'
import { findIdleCleanupCandidates, type IdleCleanupInput } from '../src/shared/idle-cleanup'
import { runIdleCleanupSweep, type IdleCleanupEnvironment } from '../src/main/idle-cleanup-sweep'
import { TabActivityRegistry } from '../src/main/tab-activity-registry'
import { tearDownTaskTabs } from '../src/main/task-teardown'
import { RevisionStore } from '../src/main/revision-store'
import type {
  IdleTaskCleanupConfig,
  PinnedItem,
  Project,
  ProjectsData,
  RevisionEnvelope,
  TabStatusValue,
  Task,
  TaskInboxState,
  WorkspaceDeleteResult
} from '../src/shared/types'

const NOW = new Date('2026-08-04T12:00:00').getTime()
const DAY = 86_400_000

function makeTask(id: string, opts?: {
  daysIdle?: number
  inbox?: TaskInboxState
  workspace?: boolean
  aiTabIds?: string[]
  home?: boolean
}): Task {
  return {
    id,
    name: id,
    tabs: {
      left: (opts?.aiTabIds ?? []).map(tabId => ({ id: tabId, type: 'claude' as const, title: 'Claude' })),
      right: []
    },
    activeTab: { left: null, right: null },
    splitOpen: false,
    splitRatio: 0.5,
    lastInteractedAt: NOW - (opts?.daysIdle ?? 0) * DAY,
    // Settled by default so the default settledOnly config doesn't mask every other case.
    inbox: opts?.inbox ?? { settledAt: NOW - (opts?.daysIdle ?? 0) * DAY },
    ...(opts?.workspace
      ? {
          workspace: {
            worktreePath: `/tmp/wt/${id}`,
            branchName: id,
            baseBranch: 'main',
            relativeProjectPath: ''
          }
        }
      : {}),
    ...(opts?.home ? { system: 'home' as const } : {})
  }
}

function makeProject(tasks: Task[]): Project {
  return { id: 'p1', name: 'Project One', directory: '/tmp/p1', tasks }
}

function config(overrides?: Partial<IdleTaskCleanupConfig>): IdleTaskCleanupConfig {
  return {
    enabled: true,
    byAge: { enabled: true, days: 14 },
    byCount: { enabled: true, maxTasks: 20 },
    combine: 'and',
    settledOnly: true,
    includeCleanWorkspaces: false,
    ...overrides
  }
}

function run(
  tasks: Task[],
  cfg?: Partial<IdleTaskCleanupConfig>,
  extra?: Partial<IdleCleanupInput>
): string[] {
  return findIdleCleanupCandidates({
    projects: [makeProject(tasks)],
    pinnedItems: [],
    statuses: {},
    openTaskIds: [],
    config: config(cfg),
    now: NOW,
    ...extra
  }).map(candidate => candidate.taskId)
}

describe('rule composition', () => {
  it('deletes nothing when neither rule is enabled', () => {
    const tasks = [makeTask('old', { daysIdle: 400 })]
    expect(run(tasks, {
      byAge: { enabled: false, days: 14 },
      byCount: { enabled: false, maxTasks: 1 }
    })).toEqual([])
  })

  it('AND keeps an old task while the project is under the cap', () => {
    expect(run([makeTask('old', { daysIdle: 400 })], { byCount: { enabled: true, maxTasks: 20 } }))
      .toEqual([])
  })

  it('AND keeps a fresh task that is over the cap', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')]
    expect(run(tasks, { byCount: { enabled: true, maxTasks: 1 } })).toEqual([])
  })

  it('AND deletes a task that is both stale and over the cap', () => {
    const tasks = [makeTask('fresh'), makeTask('stale', { daysIdle: 30 })]
    expect(run(tasks, { byCount: { enabled: true, maxTasks: 1 } })).toEqual(['stale'])
  })

  it('OR deletes on age alone', () => {
    expect(run([makeTask('old', { daysIdle: 30 })], { combine: 'or' })).toEqual(['old'])
  })

  it('OR deletes on the cap alone', () => {
    const tasks = [makeTask('fresh'), makeTask('alsoFresh', { daysIdle: 1 })]
    expect(run(tasks, { combine: 'or', byCount: { enabled: true, maxTasks: 1 } }))
      .toEqual(['alsoFresh'])
  })

  it('lets a single enabled rule decide regardless of the combinator', () => {
    const tasks = [makeTask('old', { daysIdle: 30 })]
    const ageOnly = { byCount: { enabled: false, maxTasks: 1 } }
    expect(run(tasks, { ...ageOnly, combine: 'and' })).toEqual(['old'])
    expect(run(tasks, { ...ageOnly, combine: 'or' })).toEqual(['old'])
  })

  it('treats the age threshold as inclusive', () => {
    expect(run([makeTask('exact', { daysIdle: 14 })], { combine: 'or' })).toEqual(['exact'])
    expect(run([makeTask('under', { daysIdle: 13 })], { combine: 'or' })).toEqual([])
  })
})

describe('cap ranking', () => {
  it('ranks by last activity, newest first', () => {
    const tasks = [
      makeTask('oldest', { daysIdle: 90 }),
      makeTask('newest', { daysIdle: 20 }),
      makeTask('middle', { daysIdle: 40 })
    ]
    expect(run(tasks, { byCount: { enabled: true, maxTasks: 1 } })).toEqual(['middle', 'oldest'])
  })

  it('counts exempt tasks against the cap without deleting them', () => {
    const tasks = [
      makeTask('ws1', { daysIdle: 30, workspace: true }),
      makeTask('ws2', { daysIdle: 31, workspace: true }),
      makeTask('plain', { daysIdle: 32 })
    ]
    // maxTasks 2 puts only 'plain' over the cap; the workspaces hold the first two slots.
    expect(run(tasks, { byCount: { enabled: true, maxTasks: 2 } })).toEqual(['plain'])
  })

  it('never counts or deletes the home task', () => {
    const tasks = [
      makeTask('home', { daysIdle: 500, home: true }),
      makeTask('stale', { daysIdle: 30 })
    ]
    expect(run(tasks, { byCount: { enabled: true, maxTasks: 1 } })).toEqual([])
  })

  it('uses the inbox event stamp when it is newer than the interaction stamp', () => {
    const agentTouched = makeTask('agent', { daysIdle: 90, inbox: { settledAt: NOW - 90 * DAY, eventAt: NOW - DAY } })
    expect(run([agentTouched], { combine: 'or' })).toEqual([])
  })
})

describe('protections', () => {
  const stale = () => [makeTask('stale', { daysIdle: 30 })]
  const or = { combine: 'or' as const }

  it('keeps an unread task', () => {
    const task = makeTask('stale', {
      daysIdle: 30,
      inbox: { settledAt: NOW - 30 * DAY, eventAt: NOW - 29 * DAY, visitedAt: NOW - 30 * DAY }
    })
    expect(run([task], or)).toEqual([])
  })

  it('keeps a snoozed task', () => {
    const task = makeTask('stale', {
      daysIdle: 30,
      inbox: { settledAt: NOW - 30 * DAY, snoozedAt: NOW - DAY, snoozedUntil: NOW + DAY }
    })
    expect(run([task], or)).toEqual([])
  })

  it('keeps a task snoozed until attention', () => {
    const task = makeTask('stale', {
      daysIdle: 30,
      inbox: { settledAt: NOW - 30 * DAY, snoozedAt: NOW - DAY, snoozeUntilAttention: true }
    })
    expect(run([task], or)).toEqual([])
  })

  it('keeps a pinned task', () => {
    const pinnedItems: PinnedItem[] = [{ type: 'task', projectId: 'p1', taskId: 'stale' }]
    expect(run(stale(), or, { pinnedItems })).toEqual([])
  })

  it('keeps a task open in any window', () => {
    expect(run(stale(), or, { openTaskIds: ['stale'] })).toEqual([])
  })

  it('keeps a task with a working tab', () => {
    const task = makeTask('stale', { daysIdle: 30, aiTabIds: ['tab1'] })
    const statuses: Record<string, TabStatusValue> = { tab1: 'working' }
    expect(run([task], or, { statuses })).toEqual([])
  })

  it('keeps a task with a tab waiting on you', () => {
    const task = makeTask('stale', { daysIdle: 30, aiTabIds: ['tab1'] })
    const statuses: Record<string, TabStatusValue> = { tab1: 'attention' }
    expect(run([task], or, { statuses })).toEqual([])
  })

  it('does not protect a task whose tab merely exited', () => {
    const task = makeTask('stale', { daysIdle: 30, aiTabIds: ['tab1'] })
    const statuses: Record<string, TabStatusValue> = { tab1: 'exited' }
    expect(run([task], or, { statuses })).toEqual(['stale'])
  })

  it('keeps an unsettled task while settledOnly is on', () => {
    const task = makeTask('stale', { daysIdle: 30, inbox: {} })
    expect(run([task], or)).toEqual([])
  })

  it('deletes an unsettled task once settledOnly is off', () => {
    const task = makeTask('stale', { daysIdle: 30, inbox: {} })
    expect(run([task], { ...or, settledOnly: false })).toEqual(['stale'])
  })

  it('keeps an unread task even with settledOnly off', () => {
    const task = makeTask('stale', {
      daysIdle: 30,
      inbox: { eventAt: NOW - 29 * DAY, visitedAt: NOW - 30 * DAY }
    })
    expect(run([task], { ...or, settledOnly: false })).toEqual([])
  })

  it('treats a settled task as unsettled again once a newer event lands', () => {
    const task = makeTask('stale', {
      daysIdle: 30,
      inbox: { settledAt: NOW - 30 * DAY, eventAt: NOW - 20 * DAY, visitedAt: NOW - 19 * DAY }
    })
    expect(run([task], or)).toEqual([])
  })
})

describe('workspaces', () => {
  it('never returns a workspace task by default', () => {
    const tasks = [makeTask('ws', { daysIdle: 400, workspace: true })]
    expect(run(tasks, { combine: 'or' })).toEqual([])
  })

  it('returns workspace tasks flagged for a pre-flight when opted in', () => {
    const tasks = [makeTask('ws', { daysIdle: 400, workspace: true })]
    const candidates = findIdleCleanupCandidates({
      projects: [makeProject(tasks)],
      pinnedItems: [],
      statuses: {},
      openTaskIds: [],
      config: config({ combine: 'or', includeCleanWorkspaces: true }),
      now: NOW
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].workspace).toBe(true)
    expect(candidates[0].projectName).toBe('Project One')
  })
})

describe('live processes and unsaved buffers', () => {
  const or = { combine: 'or' as const }

  it('keeps a task whose agent only main can see (finding #7)', () => {
    // The window that would previously have swept never had this tab mounted, so
    // its own status store says nothing about it. Main heard the hook.
    const registry = new TabActivityRegistry()
    registry.working('tab1')
    const task = makeTask('stale', { daysIdle: 30, aiTabIds: ['tab1'] })
    expect(run([task], or, { statuses: registry.getSnapshot() })).toEqual([])
  })

  it('keeps a task whose agent is blocked on the user', () => {
    const registry = new TabActivityRegistry()
    registry.notification('tab1', { message: 'Claude needs your permission to use Bash' })
    const task = makeTask('stale', { daysIdle: 30, aiTabIds: ['tab1'] })
    expect(run([task], or, { statuses: registry.getSnapshot() })).toEqual([])
  })

  it('deletes it again once the agent has stopped', () => {
    const registry = new TabActivityRegistry()
    registry.working('tab1')
    registry.stopped('tab1')
    const task = makeTask('stale', { daysIdle: 30, aiTabIds: ['tab1'] })
    expect(run([task], or, { statuses: registry.getSnapshot() })).toEqual(['stale'])
  })

  it('does not treat an exited process as activity', () => {
    const registry = new TabActivityRegistry()
    registry.working('tab1')
    registry.exited('tab1')
    expect(registry.getStatus('tab1')).toBe('exited')
    const task = makeTask('stale', { daysIdle: 30, aiTabIds: ['tab1'] })
    expect(run([task], or, { statuses: registry.getSnapshot() })).toEqual(['stale'])
  })

  it('keeps a task with a live PTY even when no status was ever reported', () => {
    // A hidden AI tab keeps its process running with no window drawing its dot.
    const task = makeTask('stale', { daysIdle: 30, aiTabIds: ['tab1'] })
    expect(run([task], or, { liveTabIds: ['tab1'] })).toEqual([])
  })

  it('keeps a task holding an unsaved editor buffer', () => {
    const task = makeTask('stale', { daysIdle: 30, aiTabIds: ['tab1'] })
    expect(run([task], or, { dirtyTabIds: ['tab1'] })).toEqual([])
  })
})

describe('scoping', () => {
  it('applies the cap per project rather than globally', () => {
    const projects: Project[] = [
      { id: 'a', name: 'A', directory: '/tmp/a', tasks: [makeTask('a1'), makeTask('a2', { daysIdle: 30 })] },
      { id: 'b', name: 'B', directory: '/tmp/b', tasks: [makeTask('b1', { daysIdle: 30 })] }
    ]
    const candidates = findIdleCleanupCandidates({
      projects,
      pinnedItems: [],
      statuses: {},
      openTaskIds: [],
      config: config({ byCount: { enabled: true, maxTasks: 1 } }),
      now: NOW
    })
    // 'b1' is the only task in its project, so it is never over its own cap.
    expect(candidates.map(c => c.taskId)).toEqual(['a2'])
  })
})

/**
 * The sweep itself, as main runs it. Everything below the electron layer is
 * production code: `runIdleCleanupSweep` is what `AppRuntime` drives on its timer,
 * and the environment it is given here does what `AppRuntime` does for real.
 */
interface SweepHarness {
  env: IdleCleanupEnvironment
  /** Canonical state, mutable exactly as main's store is. */
  data: () => ProjectsData
  setTasks: (tasks: Task[]) => void
  activity: {
    openTaskIds: string[]
    statuses: Record<string, TabStatusValue>
    liveTabIds: string[]
    dirtyTabIds: string[]
  }
  cfg: IdleTaskCleanupConfig
  removed: string[]
  forgotten: string[]
  workspaceDeletes: string[]
  backups: number
  logs: string[]
}

function harness(options: {
  tasks: Task[]
  cfg?: Partial<IdleTaskCleanupConfig>
  backupProjects?: () => boolean
  deleteWorkspace?: (project: Project, task: Task) => Promise<WorkspaceDeleteResult>
  onRemove?: (task: Task) => void
}): SweepHarness {
  let data: ProjectsData = {
    projects: [makeProject(options.tasks)],
    tags: [],
    projectOrder: ['p1'],
    pinnedItems: []
  }
  const state: SweepHarness = {
    env: null as unknown as IdleCleanupEnvironment,
    data: () => data,
    setTasks: (tasks) => {
      data = { ...data, projects: [{ ...data.projects[0], tasks }] }
    },
    activity: { openTaskIds: [], statuses: {}, liveTabIds: [], dirtyTabIds: [] },
    // `or` + 30-day-idle tasks is the simplest way to make a candidate.
    cfg: config({ combine: 'or', ...options.cfg }),
    removed: [],
    forgotten: [],
    workspaceDeletes: [],
    backups: 0,
    logs: []
  }

  state.env = {
    readProjects: () => ({ projects: data.projects, pinnedItems: data.pinnedItems ?? [] }),
    readConfig: () => state.cfg,
    readActivity: () => ({
      openTaskIds: [...state.activity.openTaskIds],
      statuses: { ...state.activity.statuses },
      liveTabIds: [...state.activity.liveTabIds],
      dirtyTabIds: [...state.activity.dirtyTabIds]
    }),
    now: () => NOW,
    backupProjects: () => {
      state.backups += 1
      return options.backupProjects ? options.backupProjects() : true
    },
    deleteWorkspace: async (project, task) => {
      state.workspaceDeletes.push(task.id)
      const result = options.deleteWorkspace
        ? await options.deleteWorkspace(project, task)
        : ({ status: 'ok' } as WorkspaceDeleteResult)
      return result
    },
    removeTask: (project, task) => {
      state.removed.push(task.id)
      options.onRemove?.(task)
      data = {
        ...data,
        projects: data.projects.map(candidate => candidate.id !== project.id ? candidate : {
          ...candidate,
          tasks: candidate.tasks.filter(existing => existing.id !== task.id)
        })
      }
    },
    forgetWorkspace: (_project, task) => {
      state.forgotten.push(task.id)
      state.setTasks(data.projects[0].tasks.map(existing => {
        if (existing.id !== task.id) return existing
        const { workspace: _gone, ...rest } = existing
        return rest
      }))
    },
    log: (message) => state.logs.push(message)
  }

  return state
}

/** A promise the test resolves by hand, to hold the sweep inside an await. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('sweep', () => {
  it('deletes a genuinely idle task', async () => {
    const h = harness({ tasks: [makeTask('stale', { daysIdle: 30 })] })
    const result = await runIdleCleanupSweep(h.env)

    expect(result.deleted).toEqual([{ projectId: 'p1', taskId: 'stale' }])
    expect(h.removed).toEqual(['stale'])
    expect(h.data().projects[0].tasks).toEqual([])
    expect(h.backups).toBe(1)
  })

  it('does nothing at all while cleanup is switched off', async () => {
    const h = harness({ tasks: [makeTask('stale', { daysIdle: 30 })], cfg: { enabled: false } })
    const result = await runIdleCleanupSweep(h.env)

    expect(result.aborted).toBe('disabled')
    expect(h.removed).toEqual([])
    expect(h.backups).toBe(0)
  })

  it('does not churn the backup ring when nothing matches', async () => {
    const h = harness({ tasks: [makeTask('fresh')] })
    await runIdleCleanupSweep(h.env)

    expect(h.backups).toBe(0)
    expect(h.removed).toEqual([])
  })

  it('aborts before deleting anything when the snapshot was not written (finding #9)', async () => {
    const h = harness({
      tasks: [makeTask('stale', { daysIdle: 30 }), makeTask('ws', { daysIdle: 40, workspace: true })],
      cfg: { includeCleanWorkspaces: true },
      backupProjects: () => false
    })

    const result = await runIdleCleanupSweep(h.env)

    expect(result.aborted).toBe('backup-failed')
    expect(h.removed).toEqual([])
    // Not even the workspace pre-flight ran: that deletes a worktree of its own.
    expect(h.workspaceDeletes).toEqual([])
    expect(h.data().projects[0].tasks).toHaveLength(2)
    expect(h.logs).toContain('idleCleanupAborted reason=backup-failed')
  })

  it('stops the remaining deletions when cleanup is turned off mid-sweep', async () => {
    const h = harness({
      tasks: [makeTask('first', { daysIdle: 30 }), makeTask('second', { daysIdle: 40 })],
      onRemove: (task) => {
        if (task.id === 'first') h.cfg = { ...h.cfg, enabled: false }
      }
    })

    const result = await runIdleCleanupSweep(h.env)

    expect(h.removed).toEqual(['first'])
    expect(result.aborted).toBe('disabled')
    expect(h.data().projects[0].tasks.map(t => t.id)).toEqual(['second'])
  })

  it('leaves a workspace alone unless it is clean and merged', async () => {
    const h = harness({
      tasks: [makeTask('ws', { daysIdle: 40, workspace: true })],
      cfg: { includeCleanWorkspaces: true },
      deleteWorkspace: async () => ({ status: 'uncommitted' })
    })

    const result = await runIdleCleanupSweep(h.env)

    expect(h.removed).toEqual([])
    expect(result.skipped).toEqual([{ taskId: 'ws', reason: 'workspace-uncommitted' }])
  })

  it('leaves a workspace alone when the check itself could not be completed', async () => {
    const h = harness({
      tasks: [makeTask('ws', { daysIdle: 40, workspace: true })],
      cfg: { includeCleanWorkspaces: true },
      deleteWorkspace: async () => ({ status: 'check-failed', reason: 'git exploded' })
    })

    await runIdleCleanupSweep(h.env)
    expect(h.removed).toEqual([])
  })
})

describe('sweep revalidation (finding #8)', () => {
  it('keeps a task pinned while its workspace check was in flight', async () => {
    const gate = deferred<WorkspaceDeleteResult>()
    const h = harness({
      tasks: [makeTask('ws', { daysIdle: 40, workspace: true })],
      cfg: { includeCleanWorkspaces: true },
      deleteWorkspace: () => gate.promise
    })

    const sweep = runIdleCleanupSweep(h.env)
    await Promise.resolve()
    // The user pins it while the sweep is still awaiting git.
    h.setTasks(h.data().projects[0].tasks)
    ;(h.data().pinnedItems as PinnedItem[]).push({ type: 'task', projectId: 'p1', taskId: 'ws' })
    gate.resolve({ status: 'ok' })
    const result = await sweep

    expect(h.removed).toEqual([])
    // The worktree is gone, so the record that pointed at it had to go too.
    expect(h.forgotten).toEqual(['ws'])
    expect(h.data().projects[0].tasks[0].workspace).toBeUndefined()
    expect(result.skipped[0].reason).toBe('no-longer-eligible-after-workspace-delete')
  })

  it('keeps a task that is opened while an earlier candidate is being deleted', async () => {
    const gate = deferred<WorkspaceDeleteResult>()
    const h = harness({
      tasks: [
        makeTask('ws', { daysIdle: 20, workspace: true }),
        makeTask('plain', { daysIdle: 40 })
      ],
      cfg: { includeCleanWorkspaces: true },
      deleteWorkspace: () => gate.promise
    })

    const sweep = runIdleCleanupSweep(h.env)
    await Promise.resolve()
    // Another window selects the second candidate mid-sweep.
    h.activity.openTaskIds = ['plain']
    gate.resolve({ status: 'ok' })
    await sweep

    expect(h.removed).toEqual(['ws'])
    expect(h.data().projects[0].tasks.map(t => t.id)).toEqual(['plain'])
  })

  it('keeps a task whose agent starts working mid-sweep', async () => {
    const gate = deferred<WorkspaceDeleteResult>()
    const registry = new TabActivityRegistry()
    const h = harness({
      tasks: [
        makeTask('ws', { daysIdle: 20, workspace: true }),
        makeTask('busy', { daysIdle: 40, aiTabIds: ['tab1'] })
      ],
      cfg: { includeCleanWorkspaces: true },
      deleteWorkspace: () => gate.promise
    })

    const sweep = runIdleCleanupSweep(h.env)
    await Promise.resolve()
    registry.working('tab1')
    h.activity.statuses = registry.getSnapshot()
    gate.resolve({ status: 'ok' })
    await sweep

    expect(h.removed).toEqual(['ws'])
  })

  it('keeps a task whose editor goes dirty mid-sweep', async () => {
    const gate = deferred<WorkspaceDeleteResult>()
    const h = harness({
      tasks: [
        makeTask('ws', { daysIdle: 20, workspace: true }),
        makeTask('editing', { daysIdle: 40, aiTabIds: ['tab1'] })
      ],
      cfg: { includeCleanWorkspaces: true },
      deleteWorkspace: () => gate.promise
    })

    const sweep = runIdleCleanupSweep(h.env)
    await Promise.resolve()
    h.activity.dirtyTabIds = ['tab1']
    gate.resolve({ status: 'ok' })
    await sweep

    expect(h.removed).toEqual(['ws'])
  })

  it('skips a task another window already deleted', async () => {
    const gate = deferred<WorkspaceDeleteResult>()
    const h = harness({
      tasks: [
        makeTask('ws', { daysIdle: 20, workspace: true }),
        makeTask('plain', { daysIdle: 40 })
      ],
      cfg: { includeCleanWorkspaces: true },
      deleteWorkspace: () => gate.promise
    })

    const sweep = runIdleCleanupSweep(h.env)
    await Promise.resolve()
    h.setTasks(h.data().projects[0].tasks.filter(task => task.id !== 'plain'))
    gate.resolve({ status: 'ok' })
    const result = await sweep

    expect(h.removed).toEqual(['ws'])
    expect(result.skipped).toEqual([{ taskId: 'plain', reason: 'gone' }])
  })
})

describe('task teardown', () => {
  const project: Project = { id: 'p1', name: 'Project One', directory: '/tmp/p1', tasks: [] }

  function task(): Task {
    return {
      ...makeTask('doomed', { daysIdle: 30 }),
      tabs: {
        left: [
          { id: 'claude-1', type: 'claude', title: 'Claude' },
          { id: 'term-1', type: 'terminal', title: 'Terminal' }
        ],
        right: [{ id: 'claude-2', type: 'claude', title: 'Claude' }]
      }
    }
  }

  it('kills every PTY, drops every scrollback and releases the hooks', async () => {
    const killPty = vi.fn()
    const deleteScrollback = vi.fn()
    const forgetActivity = vi.fn()
    const releaseHooks = vi.fn()

    const tabIds = await tearDownTaskTabs(project, task(), {
      killPty, deleteScrollback, forgetActivity, releaseHooks
    })

    expect(tabIds).toEqual(['claude-1', 'term-1', 'claude-2'])
    expect(killPty.mock.calls.map(c => c[0])).toEqual(['claude-1', 'term-1', 'claude-2'])
    expect(deleteScrollback.mock.calls.map(c => c[0])).toEqual(['claude-1', 'term-1', 'claude-2'])
    expect(forgetActivity.mock.calls.map(c => c[0])).toEqual(['claude-1', 'term-1', 'claude-2'])
    // Only Claude tabs ever injected hooks.
    expect(releaseHooks.mock.calls.map(c => c[2])).toEqual(['claude-1', 'claude-2'])
    expect(releaseHooks.mock.calls[0][1]).toBe('/tmp/p1')
  })

  it('releases hooks from the worktree a workspace task actually ran in', async () => {
    const releaseHooks = vi.fn()
    const workspaceTask: Task = {
      ...task(),
      workspace: {
        worktreePath: '/tmp/p1/.worktrees/feature',
        branchName: 'feature',
        baseBranch: 'main',
        relativeProjectPath: 'packages/app'
      }
    }

    await tearDownTaskTabs(project, workspaceTask, {
      killPty: vi.fn(), deleteScrollback: vi.fn(), forgetActivity: vi.fn(), releaseHooks
    })

    expect(releaseHooks.mock.calls[0][1]).toBe('/tmp/p1/.worktrees/feature/packages/app')
  })
})

describe('deletion reaches the other windows', () => {
  it('bumps the projects revision and broadcasts the removal', async () => {
    const broadcasts: RevisionEnvelope<ProjectsData>[] = []
    const persisted: ProjectsData[] = []
    const store = new RevisionStore<ProjectsData>({
      initial: {
        projects: [makeProject([makeTask('stale', { daysIdle: 30 }), makeTask('fresh')])],
        tags: [],
        projectOrder: ['p1'],
        pinnedItems: []
      },
      persist: (data) => { persisted.push(data) },
      broadcast: (envelope) => { broadcasts.push(envelope) }
    })

    const h = harness({ tasks: [] })
    // Same wiring as AppRuntime: the sweep reads and writes canonical state only
    // through the revision store, so a deletion cannot slip past the windows.
    h.env.readProjects = () => {
      const data = store.peek()
      return { projects: data.projects, pinnedItems: data.pinnedItems ?? [] }
    }
    h.env.removeTask = (project, task) => {
      const data = store.peek()
      store.commit({
        ...data,
        projects: data.projects.map(candidate => candidate.id !== project.id ? candidate : {
          ...candidate,
          tasks: candidate.tasks.filter(existing => existing.id !== task.id)
        })
      })
    }

    await runIdleCleanupSweep(h.env)

    expect(store.getRevision()).toBe(1)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].revision).toBe(1)
    expect(broadcasts[0].data.projects[0].tasks.map(t => t.id)).toEqual(['fresh'])
    expect(persisted[0].projects[0].tasks.map(t => t.id)).toEqual(['fresh'])
  })
})

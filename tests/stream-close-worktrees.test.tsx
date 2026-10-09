// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_CONFIG, type Project, type ProjectsData, type Stream, type Tab, type Task, type TaskLandingPreview, type TaskLandingResult, type WorkspaceConfig } from '../src/shared/types'
import type { ArchivedStream } from '../src/shared/archive'
import { removeTaskFromProject } from '../src/shared/streams'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'
import { AppProvider } from '../src/renderer/context/AppContext'
import { TabStatusProvider } from '../src/renderer/context/TabStatusContext'
import Sidebar from '../src/renderer/components/Sidebar'
import { streamTasksCloseQuestion, taskHasWork } from '../src/renderer/components/sidebar/closeRules'

void React

const streamWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/rel', branchName: 'rel', baseBranch: 'main', relativeProjectPath: '' }

function ownWs(slug: string): WorkspaceConfig {
  return { worktreePath: `/repo/.worktrees/rel--${slug}`, branchName: `rel--${slug}`, baseBranch: 'rel', relativeProjectPath: '' }
}

const agent = (id: string): Tab => ({ id: `tab-${id}`, type: 'claude-chat', title: 'Claude', sessionId: `s-${id}` })

function ownTask(id: string, name: string, extra: Partial<Task> = {}): Task {
  return { ...fixtureTask({ id, name, tabs: { left: [agent(id)] }, ownWorkspace: ownWs(id) }), ...extra }
}

function streamOf(tasks: Task[]): Stream {
  return { id: 'stream-rel', name: 'rel', workspace: streamWs, taskWorktrees: true, tasks }
}

function worktreeProject(tasks: Task[]): Project {
  return fixtureProject({ id: 'p1', name: 'Alpha', directory: '/repo', streams: [streamOf(tasks)] })
}

describe('streamTasksCloseQuestion', () => {
  const check = (task: Task, preview: TaskLandingPreview | null, working = false) => ({ task, preview, working })

  it('asks nothing when no task has anything to land', () => {
    const tasks = [ownTask('a', 'A'), ownTask('b', 'B')]
    expect(streamTasksCloseQuestion(streamOf(tasks), tasks.map(task => check(task, { commits: 0, uncommitted: 0 })))).toBeNull()
  })

  it('lists the tasks with work, in order, with what each holds', () => {
    const a = ownTask('a', 'Login')
    const b = ownTask('b', 'Clean')
    const c = ownTask('c', 'Docs')
    const question = streamTasksCloseQuestion(streamOf([a, b, c]), [
      check(a, { commits: 2, uncommitted: 1 }),
      check(b, { commits: 0, uncommitted: 0 }),
      check(c, null)
    ])
    expect(question).toEqual({
      title: 'Close stream "rel"?',
      streamName: 'rel',
      tasks: [
        { taskId: 'a', name: 'Login', holds: '2 commits, uncommitted changes in 1 file' },
        { taskId: 'c', name: 'Docs', holds: 'work DevTool could not check' }
      ],
      landBlocked: null
    })
  })

  it('holds Land all back while an agent works or a conflict stands, not for a blocked landing', () => {
    const working = ownTask('a', 'Busy')
    expect(streamTasksCloseQuestion(streamOf([working]), [check(working, { commits: 0, uncommitted: 0 }, true)])?.landBlocked)
      .toBe('"Busy" is still working')
    const conflict = ownTask('b', 'Stuck', { landing: { state: 'conflict', files: ['a.txt'] } })
    expect(streamTasksCloseQuestion(streamOf([conflict]), [check(conflict, null)])).toMatchObject({
      tasks: [{ holds: 'a landing stopped on conflicts' }],
      landBlocked: 'Finish or abort the landing of "Stuck" first'
    })
    const blocked = ownTask('c', 'Blocked', { landing: { state: 'blocked', files: [] } })
    expect(taskHasWork(check(blocked, { commits: 0, uncommitted: 0 }))).toBe(true)
    expect(streamTasksCloseQuestion(streamOf([blocked]), [check(blocked, { commits: 1, uncommitted: 0 })])?.landBlocked).toBeNull()
  })
})

describe('closing a stream whose tasks have worktrees of their own', () => {
  let saved: ProjectsData[]
  let current: ProjectsData
  let broadcast: ((update: { source: string; revision: number; data: ProjectsData }) => void) | null
  let api: Record<string, ReturnType<typeof vi.fn>>
  let previews: Record<string, TaskLandingPreview>
  let landResults: Record<string, TaskLandingResult>

  const tasks = () => [ownTask('t1', 'Login'), ownTask('t2', 'Styles'), ownTask('t3', 'Clean')]

  beforeEach(() => {
    saved = []
    broadcast = null
    current = { projects: [worktreeProject(tasks())], tags: [], projectOrder: ['p1'], pinnedItems: [] }
    previews = { t1: { commits: 2, uncommitted: 0 }, t2: { commits: 0, uncommitted: 3 }, t3: { commits: 0, uncommitted: 0 } }
    landResults = {}
    let revision = 100
    api = {
      loadProjects: vi.fn().mockImplementation(async () => ({ local: { revision: 0, data: current } })),
      loadConfig: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG, autoCollapseQuietStreams: false }),
      loadWindowState: vi.fn().mockResolvedValue({ expandedProjectIds: ['p1'], sidebarTab: 'projects' }),
      notesLoad: vi.fn().mockResolvedValue({ revision: 0, data: {} }),
      saveProjects: vi.fn().mockImplementation((_source: string, payload: { data: ProjectsData }) => {
        saved.push(payload.data)
        current = payload.data
        return Promise.resolve({ ok: true, revision: ++revision })
      }),
      onProjectsUpdated: vi.fn().mockImplementation((callback: typeof broadcast) => {
        broadcast = callback
        return () => {}
      }),
      getNativeTheme: vi.fn().mockResolvedValue('dark'),
      sshStatus: vi.fn().mockResolvedValue('disconnected'),
      getAgentActivity: vi.fn().mockResolvedValue({}),
      taskStreamAhead: vi.fn().mockResolvedValue(0),
      taskLandingPreview: vi.fn().mockImplementation(async (_p: string, taskId: string) => previews[taskId]),
      // Main lands the task, and its close archives it there: the window hears it as a broadcast.
      taskLand: vi.fn().mockImplementation(async (projectId: string, taskId: string) => {
        const result = landResults[taskId] ?? { status: 'landed' }
        if (result.status === 'landed' || result.status === 'nothing') {
          current = { ...current, projects: current.projects.map(p => (p.id === projectId ? removeTaskFromProject(p, taskId) : p)) }
          broadcast?.({ source: 'local', revision: ++revision, data: current })
        }
        return result
      }),
      taskWorktreeClose: vi.fn().mockResolvedValue({ status: 'removed' } satisfies TaskLandingResult),
      // The stream's own worktree: clean and merged, so its pre-flight removes it.
      workspaceDelete: vi.fn().mockResolvedValue({ status: 'ok' }),
      archiveAddStream: vi.fn().mockImplementation(async (_p: string, entry: ArchivedStream) => ({ version: 1, tasks: [], streams: [entry] }))
    }
    ;(window as unknown as { api: unknown }).api = new Proxy(api, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        const fn = prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(() => Promise.resolve(undefined))
        target[prop] = fn
        return fn
      }
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function renderSidebar() {
    return render(
      <TabStatusProvider>
        <AppProvider>
          <Sidebar />
        </AppProvider>
      </TabStatusProvider>
    )
  }

  const streamRow = (id: string) => document.querySelector<HTMLElement>(`[data-tree-row="stream"][data-stream-id="${id}"]`)!
  const lastStreams = () => (saved[saved.length - 1] ?? current).projects[0].streams.map(stream => stream.id)
  const archivedStream = (): ArchivedStream => api.archiveAddStream.mock.calls[0][1] as ArchivedStream

  async function closeStream(): Promise<void> {
    await screen.findByText('Login')
    fireEvent.click(within(streamRow('stream-rel')).getByTitle('Close stream'))
  }

  it('lists the tasks with work; Land all lands them in order, then the rest go with the stream', async () => {
    renderSidebar()
    await closeStream()
    const list = await screen.findByTestId('stream-close-tasks')
    expect(list.textContent).toBe('Login · 2 commitsStyles · uncommitted changes in 3 files')

    fireEvent.click(screen.getByRole('button', { name: 'Land all, then close' }))
    await waitFor(() => expect(api.archiveAddStream).toHaveBeenCalled())
    expect(api.taskLand.mock.calls.map(call => call[1])).toEqual(['t1', 't2'])
    // Nothing to land: its worktree just goes, and it stays with the stream.
    expect(api.taskWorktreeClose.mock.calls).toEqual([['p1', 't3', 'discard', { archive: false }]])
    expect(archivedStream().stream.tasks.map(task => task.id)).toEqual(['t3'])
    await waitFor(() => expect(lastStreams()).not.toContain('stream-rel'))
  })

  it('Land all stops at the first conflict and leaves the stream open', async () => {
    landResults.t1 = { status: 'conflict', files: ['a.txt'] }
    renderSidebar()
    await closeStream()
    fireEvent.click(await screen.findByRole('button', { name: 'Land all, then close' }))

    await waitFor(() => expect(api.taskLand).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(api.taskLand).toHaveBeenCalledWith('p1', 't1')
    expect(api.taskWorktreeClose).not.toHaveBeenCalled()
    expect(api.workspaceDelete).not.toHaveBeenCalled()
    expect(api.archiveAddStream).not.toHaveBeenCalled()
    expect(lastStreams()).toContain('stream-rel')
  })

  it('a conflict further down keeps what landed before it archived', async () => {
    landResults.t2 = { status: 'blocked', files: ['a.txt'], message: 'local changes' }
    renderSidebar()
    await closeStream()
    fireEvent.click(await screen.findByRole('button', { name: 'Land all, then close' }))

    await waitFor(() => expect(api.taskLand).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(api.archiveAddStream).not.toHaveBeenCalled()
    const stream = current.projects[0].streams.find(candidate => candidate.id === 'stream-rel')
    expect(stream?.tasks.map(task => task.id)).toEqual(['t2', 't3'])
  })

  it('Keep branches keeps each branch with work and records every worktree on its task', async () => {
    renderSidebar()
    await closeStream()
    fireEvent.click(await screen.findByRole('button', { name: 'Keep branches' }))

    await waitFor(() => expect(api.archiveAddStream).toHaveBeenCalled())
    expect(api.taskLand).not.toHaveBeenCalled()
    expect(api.taskWorktreeClose.mock.calls).toEqual([
      ['p1', 't1', 'keep', { archive: false }],
      ['p1', 't2', 'keep', { archive: false }],
      ['p1', 't3', 'discard', { archive: false }]
    ])
    // Each task goes into the archive with its worktree: reopening restores it from there.
    expect(archivedStream().stream.tasks.map(task => task.workspace?.branchName)).toEqual(['rel--t1', 'rel--t2', 'rel--t3'])
    expect(archivedStream().stream.taskWorktrees).toBe(true)
    // The stream's clean worktree goes, but its branch stays: the kept branches come back on top of it.
    expect(api.workspaceDelete).toHaveBeenCalledWith(expect.objectContaining({ branchName: 'rel', keepBranch: true }))
    expect(api.workspaceDelete).not.toHaveBeenCalledWith(expect.objectContaining({ force: true }))
  })

  it('Discard all discards every task worktree', async () => {
    renderSidebar()
    await closeStream()
    fireEvent.click(await screen.findByRole('button', { name: 'Discard all' }))

    await waitFor(() => expect(api.archiveAddStream).toHaveBeenCalled())
    expect(api.taskWorktreeClose.mock.calls.map(call => [call[1], call[2]])).toEqual([['t1', 'discard'], ['t2', 'discard'], ['t3', 'discard']])
    expect(api.workspaceDelete).toHaveBeenCalledWith(expect.not.objectContaining({ keepBranch: true }))
  })

  it('cancel touches nothing', async () => {
    renderSidebar()
    await closeStream()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('stream-close-tasks')).toBeNull())
    expect(api.taskLand).not.toHaveBeenCalled()
    expect(api.taskWorktreeClose).not.toHaveBeenCalled()
    expect(api.workspaceDelete).not.toHaveBeenCalled()
  })

  it('asks nothing when no task has work: their worktrees go and the stream closes', async () => {
    previews = { t1: { commits: 0, uncommitted: 0 }, t2: { commits: 0, uncommitted: 0 }, t3: { commits: 0, uncommitted: 0 } }
    renderSidebar()
    await closeStream()

    await waitFor(() => expect(api.archiveAddStream).toHaveBeenCalled())
    expect(screen.queryByTestId('stream-close-tasks')).toBeNull()
    expect(api.taskWorktreeClose.mock.calls.map(call => call[2])).toEqual(['discard', 'discard', 'discard'])
  })
})

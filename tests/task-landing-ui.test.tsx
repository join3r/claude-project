// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, type Project, type ProjectsData, type Stream, type Tab, type Task, type TaskLandingResult, type WorkspaceConfig } from '../src/shared/types'
import { projectTasks } from '../src/shared/streams'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'
import { AppProvider } from '../src/renderer/context/AppContext'
import { TabStatusProvider } from '../src/renderer/context/TabStatusContext'
import Sidebar from '../src/renderer/components/Sidebar'
import {
  landingActionBlocker,
  landingSummary,
  taskLandingCloseQuestion
} from '../src/renderer/components/sidebar/closeRules'
import { isYourTurn, landingNeedsYou, landingStatusLabel, partitionInbox } from '../src/renderer/components/inbox'
import { taskStatusChip } from '../src/renderer/components/taskHeaderState'
import { isQuietStream } from '../src/renderer/components/sidebar/streamTree'

void React

const streamWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/0.5.0', branchName: '0.5.0', baseBranch: 'main', relativeProjectPath: '' }
const ownWs: WorkspaceConfig = { worktreePath: '/repo/.worktrees/0.5.0--fix', branchName: '0.5.0--fix', baseBranch: '0.5.0', relativeProjectPath: '' }
const agent: Tab = { id: 'tab-agent', type: 'claude-chat', title: 'Claude', sessionId: 's1' }

function landingTask(extra: Partial<Task> = {}): Task {
  return { ...fixtureTask({ id: 't1', name: 'Fix it', tabs: { left: [agent] }, ownWorkspace: ownWs }), ...extra }
}

function worktreeProject(task: Task): Project {
  const stream: Stream = { id: 'stream-rel', name: '0.5.0', workspace: streamWs, taskWorktrees: true, tasks: [task] }
  return fixtureProject({ id: 'p1', name: 'Alpha', directory: '/repo', streams: [stream] })
}

const idle = () => undefined

describe('closing a task with a worktree of its own', () => {
  it('says what landing would take', () => {
    expect(landingSummary({ commits: 3, uncommitted: 2 }, '0.5.0')).toBe('Squash 3 commits and uncommitted changes in 2 files into 0.5.0.')
    expect(landingSummary({ commits: 1, uncommitted: 0 }, '0.5.0')).toBe('Squash 1 commit into 0.5.0.')
    expect(landingSummary({ commits: 0, uncommitted: 1 }, '0.5.0')).toBe('Commit uncommitted changes in 1 file into 0.5.0.')
  })

  it('asks nothing when there is nothing to land, and offers Land otherwise', () => {
    const task = landingTask()
    expect(taskLandingCloseQuestion(task, '0.5.0', { commits: 0, uncommitted: 0 }, false)).toBeNull()
    expect(taskLandingCloseQuestion(task, '0.5.0', { commits: 2, uncommitted: 0 }, false)).toEqual({
      title: 'Close task "Fix it"?',
      message: 'Squash 2 commits into 0.5.0.',
      branch: '0.5.0--fix',
      landBlocked: null
    })
    // Main couldn't tell: still asks, still lands by default.
    expect(taskLandingCloseQuestion(task, '0.5.0', null, false)?.landBlocked).toBeNull()
  })

  it('offers only Keep branch / Discard while working or stopped on a conflict', () => {
    const working = taskLandingCloseQuestion(landingTask(), '0.5.0', null, true)
    expect(working?.landBlocked).toBe('Its agent is working')
    expect(working?.message).toMatch(/still working/)

    const conflict = landingTask({ landing: { state: 'conflict', intent: 'close', files: ['a.txt', 'b.txt'] } })
    const question = taskLandingCloseQuestion(conflict, '0.5.0', null, false)
    expect(question?.landBlocked).toBe('Resolve the conflicts first')
    expect(question?.message).toMatch(/^Landing into 0\.5\.0 stopped on conflicts in 2 files/)

    const blocked = landingTask({ landing: { state: 'blocked', files: ['a.txt'], message: 'error: …' } })
    expect(taskLandingCloseQuestion(blocked, '0.5.0', null, false)).toMatchObject({ landBlocked: null, message: expect.stringMatching(/^0\.5\.0 has local changes in a\.txt/) })
  })

  it('blocks the menu\'s Land / Update while the agent works or a landing is under way', () => {
    const task = landingTask()
    expect(landingActionBlocker(task, idle, false)).toBeNull()
    expect(landingActionBlocker(task, (id) => (id === 'tab-agent' ? 'working' : null), false)).toBe('agent working')
    expect(landingActionBlocker(task, idle, true)).toBe('landing…')
    expect(landingActionBlocker(landingTask({ landing: { state: 'conflict' } }), idle, false)).toBe('landing stopped')
  })
})

describe('a stopped landing in the inbox', () => {
  const NOW = 1_000_000

  it('is your turn, over snooze, and says where it stands', () => {
    const conflict = landingTask({ landing: { state: 'conflict', files: ['a.txt'] }, inbox: { snoozedUntil: NOW + 60_000, snoozedAt: NOW - 1 } })
    const project = worktreeProject(conflict)
    const stream = project.streams[1]
    expect(landingNeedsYou(conflict)).toBe(true)
    expect(isYourTurn(conflict, null)).toBe(true)
    // A busy terminal doesn't hide it.
    expect(isYourTurn(conflict, 'working')).toBe(true)
    const partition = partitionInbox([{ task: conflict, project, stream }], { 'tab-agent': 'working' }, {}, NOW)
    expect(partition.yourTurn.map(entry => entry.task.id)).toEqual(['t1'])
    expect(partition.snoozed).toEqual([])
    expect(partition.working).toEqual([])

    // Fixing is the agent's: not your turn by itself.
    const fixing = landingTask({ landing: { state: 'fixing', files: ['a.txt'] } })
    expect(landingNeedsYou(fixing)).toBe(false)

    expect(landingStatusLabel(conflict.landing, '0.5.0')).toBe('conflicts with 0.5.0 in 1 file')
    expect(landingStatusLabel({ state: 'blocked', files: ['a', 'b'] }, '0.5.0')).toBe('0.5.0 has local changes in 2 files')
    expect(landingStatusLabel({ state: 'landing', intent: 'update' }, '0.5.0')).toBe('updating from 0.5.0…')
    expect(taskStatusChip(conflict, {}, {}, NOW)).toEqual({ label: 'Conflicts', tone: 'attention' })
    expect(taskStatusChip(fixing, { 'tab-agent': 'working' }, {}, NOW)).toEqual({ label: 'Fixing conflicts', tone: 'working' })
  })

  it('keeps its stream unfolded', () => {
    const stream = worktreeProject(landingTask({ landing: { state: 'blocked' } })).streams[1]
    expect(isQuietStream(stream, () => null)).toBe(false)
    expect(isQuietStream({ ...stream, tasks: [landingTask()] }, () => null)).toBe(true)
  })
})

describe('the close question in the sidebar', () => {
  let saved: ProjectsData[]
  let projectsFixture: () => Project[]
  let api: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    saved = []
    projectsFixture = () => [worktreeProject(landingTask())]
    api = {
      loadProjects: vi.fn().mockImplementation(async () => ({ local: {
        revision: 0,
        data: { projects: projectsFixture(), tags: [], projectOrder: ['p1'], pinnedItems: [] }
      } })),
      loadConfig: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG, autoCollapseQuietStreams: false }),
      loadWindowState: vi.fn().mockResolvedValue({ expandedProjectIds: ['p1'], sidebarTab: 'projects' }),
      notesLoad: vi.fn().mockResolvedValue({ revision: 0, data: {} }),
      saveProjects: vi.fn().mockImplementation((_source: string, payload: { data: ProjectsData }) => {
        saved.push(payload.data)
        return Promise.resolve({ ok: true, revision: saved.length })
      }),
      getNativeTheme: vi.fn().mockResolvedValue('dark'),
      sshStatus: vi.fn().mockResolvedValue('disconnected'),
      getAgentActivity: vi.fn().mockResolvedValue({}),
      taskLandingPreview: vi.fn().mockResolvedValue({ commits: 2, uncommitted: 1 }),
      taskLand: vi.fn().mockResolvedValue({ status: 'landed' } satisfies TaskLandingResult),
      taskWorktreeClose: vi.fn().mockResolvedValue({ status: 'removed' } satisfies TaskLandingResult),
      taskStreamAhead: vi.fn().mockResolvedValue(3),
      archiveAddTasks: vi.fn().mockResolvedValue({ version: 1, tasks: [], streams: [] })
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

  const lastTasks = () => projectTasks(saved[saved.length - 1]?.projects[0])

  async function openClose(): Promise<void> {
    fireEvent.contextMenu(await screen.findByText('Fix it'))
    fireEvent.click(await screen.findByText('Close task', { selector: 'button' }))
  }

  it('lands by default, and main archives', async () => {
    renderSidebar()
    await openClose()
    expect((await screen.findByTestId('task-close-summary')).textContent).toBe('Squash 2 commits and uncommitted changes in 1 file into 0.5.0.')
    fireEvent.click(screen.getByRole('button', { name: 'Land & close' }))
    await waitFor(() => expect(api.taskLand).toHaveBeenCalledWith('p1', 't1'))
    expect(api.taskWorktreeClose).not.toHaveBeenCalled()
    // The landing's close archives in main, in the step that drops the worktree.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(api.archiveAddTasks).not.toHaveBeenCalled()
  })

  it.each([
    ['Keep branch', 'keep'],
    ['Discard', 'discard']
  ])('%s closes the worktree without landing', async (button, mode) => {
    renderSidebar()
    await openClose()
    fireEvent.click(await screen.findByRole('button', { name: button }))
    await waitFor(() => expect(api.taskWorktreeClose).toHaveBeenCalledWith('p1', 't1', mode))
    expect(api.taskLand).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(api.archiveAddTasks).not.toHaveBeenCalled()
  })

  it('cancel leaves the task alone', async () => {
    renderSidebar()
    await openClose()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('task-close-summary')).toBeNull())
    expect(api.taskLand).not.toHaveBeenCalled()
    expect(api.taskWorktreeClose).not.toHaveBeenCalled()
    expect(screen.getByText('Fix it')).toBeTruthy()
  })

  it('asks nothing when there is nothing to land, and keeps a task whose landing stopped', async () => {
    api.taskLandingPreview.mockResolvedValue({ commits: 0, uncommitted: 0 })
    api.taskLand.mockResolvedValue({ status: 'conflict', files: ['a.txt'] })
    renderSidebar()
    await openClose()
    await waitFor(() => expect(api.taskLand).toHaveBeenCalledWith('p1', 't1'))
    expect(screen.queryByTestId('task-close-summary')).toBeNull()
    // Not archived: no save drops it.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(saved.every(data => projectTasks(data.projects[0]).some(t => t.id === 't1'))).toBe(true)
  })

  it('closes a task sharing its stream\'s worktree as before', async () => {
    projectsFixture = () => [worktreeProject({ ...landingTask(), workspace: undefined, sharesStreamWorktree: true })]
    renderSidebar()
    await openClose()
    await waitFor(() => expect(lastTasks().some(t => t.id === 't1')).toBe(false))
    expect(api.taskLandingPreview).not.toHaveBeenCalled()
    expect(api.taskLand).not.toHaveBeenCalled()
  })

  it('lands from the menu without closing, and shows how far the stream is ahead', async () => {
    renderSidebar()
    // Asked when the task is selected.
    fireEvent.click(await screen.findByText('Fix it'))
    await waitFor(() => expect(api.taskStreamAhead).toHaveBeenCalledWith('p1', 't1'))
    expect((await screen.findByTestId('task-stream-ahead')).textContent).toBe('0.5.0 +3')
    fireEvent.contextMenu(screen.getByText('Fix it'))
    fireEvent.click(await screen.findByRole('button', { name: 'Land into 0.5.0' }))
    await waitFor(() => expect(api.taskLand).toHaveBeenCalledWith('p1', 't1', { keepWorktree: true }))
    expect(screen.getByText('Fix it')).toBeTruthy()
  })
})

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, mainStreamId, type Project, type ProjectsData, type Stream, type Task, type WorkspaceConfig } from '../src/shared/types'
import { emptyArchive, withArchivedStream, withArchivedTasks, withoutArchived, type ArchivedTask, type ProjectArchive } from '../src/shared/archive'
import { useAppState } from '../src/renderer/hooks/useAppState'
import { resetArchiveStore } from '../src/renderer/hooks/archiveStore'
import { findTaskInProject, projectTasks } from '../src/shared/streams'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

void React

/**
 * Close → Done → Reopen through the app state, with main's archive file kept
 * in memory: what the sidebar's ✕ and a Done row's Reopen do.
 */

const WORKTREE: WorkspaceConfig = { worktreePath: '/tmp/p1/.worktrees/rel', branchName: 'rel', baseBranch: 'master', relativeProjectPath: '' }

function buildProjects(): Project[] {
  return [fixtureProject({
    id: 'p1',
    directory: '/tmp/p1',
    tasks: [
      { id: 't1', tabs: { left: [{ id: 'tab-1', type: 'claude', title: 'Claude Code', sessionId: 'aaaaaaaa-1111' }] } },
      { id: 'w1', workspace: WORKTREE, tabs: { left: [{ id: 'tab-w', type: 'claude', title: 'Claude Code', sessionId: 'bbbbbbbb-2222' }] } }
    ]
  })]
}

let archive: ProjectArchive
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  resetArchiveStore()
  archive = emptyArchive()
  api = {
    loadProjects: vi.fn().mockResolvedValue({ local: {
      revision: 0,
      data: { projects: buildProjects(), tags: [], projectOrder: ['p1'], pinnedItems: [{ type: 'stream', projectId: 'p1', streamId: 'stream-w1' }] }
    } }),
    loadConfig: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
    loadWindowState: vi.fn().mockResolvedValue(null),
    notesLoad: vi.fn().mockResolvedValue({ revision: 0, data: {} }),
    notesSave: vi.fn().mockResolvedValue({ ok: true, revision: 1 }),
    saveProjects: vi.fn().mockImplementation((_source: string, _payload: { data: ProjectsData }) => Promise.resolve({ ok: true, revision: 1 })),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    saveWindowState: vi.fn().mockResolvedValue(undefined),
    getNativeTheme: vi.fn().mockResolvedValue('dark'),
    onThemeChanged: vi.fn(),
    onProjectsUpdated: vi.fn().mockReturnValue(() => {}),
    onNotesUpdated: vi.fn().mockReturnValue(() => {}),
    onTasksRemoved: vi.fn().mockReturnValue(() => {}),
    onTabsRemoved: vi.fn().mockReturnValue(() => {}),
    onTabsRestart: vi.fn().mockReturnValue(() => {}),
    onTabsMoved: vi.fn().mockReturnValue(() => {}),
    onConfigUpdated: vi.fn().mockReturnValue(() => {}),
    onArchiveChanged: vi.fn().mockReturnValue(() => {}),
    reportDirtyTabs: vi.fn().mockResolvedValue(undefined),
    sshStatus: vi.fn().mockResolvedValue('disconnected'),
    scrollbackDelete: vi.fn().mockResolvedValue(undefined),
    workspaceDelete: vi.fn().mockResolvedValue({ status: 'ok' }),
    workspaceRestore: vi.fn(),
    taskMovePrepare: vi.fn().mockResolvedValue({ dirsExist: [] }),
    archiveLoad: vi.fn().mockImplementation(() => Promise.resolve(archive)),
    archiveAddTasks: vi.fn().mockImplementation((_p: string, entries) => Promise.resolve(archive = withArchivedTasks(archive, entries))),
    archiveAddStream: vi.fn().mockImplementation((_p: string, entry) => Promise.resolve(archive = withArchivedStream(archive, entry))),
    archiveRemove: vi.fn().mockImplementation((_p: string, ids) => Promise.resolve(archive = withoutArchived(archive, ids))),
    archiveDeleteTabs: vi.fn().mockResolvedValue(undefined)
  }
  ;(window as any).api = api
  vi.spyOn(window, 'alert').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function mountState() {
  const hook = renderHook(() => useAppState())
  await waitFor(() => expect(hook.result.current.projects).toHaveLength(1))
  return hook
}

const ids = (project: Project) => project.streams.map(stream => [stream.id, stream.tasks.map(task => task.id)])

describe('archive and reopen', () => {
  it('a task goes to its stream\'s Done and comes back where it was', async () => {
    const { result } = await mountState()

    await act(async () => { await result.current.archiveTask('p1', 't1') })
    expect(ids(result.current.projects[0])).toEqual([[mainStreamId('p1'), []], ['stream-w1', ['w1']]])
    expect(result.current.projects[0].streams[0].archivedTaskCount).toBe(1)
    expect(archive.tasks.map(entry => entry.task.id)).toEqual(['t1'])
    // Its scrollback stays for Reopen.
    expect(api.scrollbackDelete).not.toHaveBeenCalled()

    await act(async () => { await result.current.reopenTask('p1', 't1') })
    expect(ids(result.current.projects[0])).toEqual([[mainStreamId('p1'), ['t1']], ['stream-w1', ['w1']]])
    expect(result.current.projects[0].streams[0].archivedTaskCount).toBeUndefined()
    expect(result.current.selectedTaskId).toBe('t1')
    expect(archive.tasks).toEqual([])
    // Same directory: no session copy needed.
    expect(api.taskMovePrepare).not.toHaveBeenCalled()
  })

  it('a worktree stream comes back on its branch, with its tasks', async () => {
    const { result } = await mountState()
    await act(async () => { await result.current.archiveStream('p1', 'stream-w1', true) })
    expect(result.current.projects[0].streams.map(s => s.id)).toEqual([mainStreamId('p1')])
    expect(result.current.projects[0].archivedStreamCount).toBe(1)
    expect(result.current.pinnedItems).toEqual([])
    expect(archive.streams[0].stream).toMatchObject({ id: 'stream-w1', workspace: WORKTREE })

    api.workspaceRestore.mockResolvedValue({ status: 'ok', worktreePath: WORKTREE.worktreePath, branchName: 'rel', relativeProjectPath: '' })
    let outcome: { reopened: boolean; notice?: string } = { reopened: false }
    await act(async () => { outcome = await result.current.reopenStream('p1', 'stream-w1') })
    expect(outcome).toEqual({ reopened: true, notice: undefined })
    expect(result.current.projects[0].streams[1]).toMatchObject({ id: 'stream-w1', workspace: WORKTREE })
    expect(projectTasks(result.current.projects[0]).map(t => t.id)).toEqual(['t1', 'w1'])
    expect(result.current.projects[0].archivedStreamCount).toBeUndefined()
    expect(archive.streams).toEqual([])
  })

  it('a stream whose branch was discarded reopens in the project folder, says so, and takes its sessions along', async () => {
    const { result } = await mountState()
    await act(async () => { await result.current.archiveStream('p1', 'stream-w1', true) })

    api.workspaceRestore.mockResolvedValue({ status: 'branch-missing' })
    let outcome: { reopened: boolean; notice?: string } = { reopened: false }
    await act(async () => { outcome = await result.current.reopenStream('p1', 'stream-w1') })

    expect(outcome.reopened).toBe(true)
    expect(outcome.notice).toMatch(/Branch "rel" no longer exists/)
    const stream = result.current.projects[0].streams[1]
    expect(stream.id).toBe('stream-w1')
    expect(stream.workspace).toBeUndefined()
    expect(stream.tasks.map(t => t.id)).toEqual(['w1'])
    expect(api.taskMovePrepare).toHaveBeenCalledWith(
      WORKTREE.worktreePath, '/tmp/p1', [{ kind: 'claude', sessionId: 'bbbbbbbb-2222' }], [], 'p1', undefined
    )
  })

  it('deleting an archived task for good drops it, its count and its scrollback', async () => {
    const { result } = await mountState()
    await act(async () => { await result.current.archiveTask('p1', 't1') })
    await act(async () => { await result.current.deleteArchived('p1', { tasks: ['t1'] }) })
    expect(archive.tasks).toEqual([])
    expect(result.current.projects[0].streams[0].archivedTaskCount).toBeUndefined()
    expect(api.archiveDeleteTabs).toHaveBeenCalledWith(['tab-1'])
  })

  it('closes nothing when the archive cannot be written', async () => {
    const { result } = await mountState()
    api.archiveAddTasks.mockRejectedValue(new Error('disk full'))
    let closed = true
    await act(async () => { closed = await result.current.archiveTask('p1', 't1') })
    expect(closed).toBe(false)
    expect(projectTasks(result.current.projects[0]).map(t => t.id)).toContain('t1')
    expect(window.alert).toHaveBeenCalledWith(expect.stringMatching(/disk full/))
  })
})

describe('reopening into task worktrees', () => {
  const STREAM_WS: WorkspaceConfig = { worktreePath: '/tmp/p1/.worktrees/rel', branchName: 'rel', baseBranch: 'master', relativeProjectPath: '' }
  const KEPT: WorkspaceConfig = { worktreePath: '/tmp/p1/.worktrees/rel--kept', branchName: 'rel--kept', baseBranch: 'rel', relativeProjectPath: '' }
  const FRESH: WorkspaceConfig = { worktreePath: '/tmp/p1/.worktrees/rel--old', branchName: 'rel--old', baseBranch: 'rel', relativeProjectPath: '' }
  const claudeTab = (id: string) => ({ id: `tab-${id}`, type: 'claude' as const, title: 'Claude Code', sessionId: `session-${id}` })

  function archivedTask(id: string, extra: Partial<Task>, dir: string, streamId = 'stream-rel'): ArchivedTask {
    return { task: { ...fixtureTask({ id, name: id, tabs: { left: [claudeTab(id)] } }), ...extra }, streamId, streamName: 'rel', dir, archivedAt: 1 }
  }

  function withStreams(streams: Stream[]): void {
    api.loadProjects.mockResolvedValue({ local: {
      revision: 0,
      data: { projects: [fixtureProject({ id: 'p1', directory: '/tmp/p1', streams })], tags: [], projectOrder: ['p1'], pinnedItems: [] }
    } })
  }

  const relStream = (tasks: Task[] = []): Stream => ({ id: 'stream-rel', name: 'rel', workspace: STREAM_WS, taskWorktrees: true, tasks, archivedTaskCount: 1 })
  const taskIn = (project: Project, id: string) => findTaskInProject(project, id)

  beforeEach(() => {
    api.taskWorktreeEnsure = vi.fn()
    api.taskWorktreeStates = vi.fn().mockResolvedValue({})
    api.onTaskWorktreeState = vi.fn().mockReturnValue(() => {})
  })

  it('a task closed with Keep branch gets its worktree back before its tabs start', async () => {
    withStreams([relStream()])
    archive = withArchivedTasks(emptyArchive(), [archivedTask('kept', { workspace: KEPT }, KEPT.worktreePath)])
    api.taskWorktreeEnsure.mockResolvedValue({ status: 'ready', workspace: KEPT })
    const { result } = await mountState()

    await act(async () => { await result.current.reopenTask('p1', 'kept') })

    expect(api.taskWorktreeEnsure).toHaveBeenCalledWith('p1', 'kept', { name: 'kept', streamId: 'stream-rel' })
    expect(taskIn(result.current.projects[0], 'kept')?.workspace).toEqual(KEPT)
    // Back where it ran: nothing to carry.
    expect(api.taskMovePrepare).not.toHaveBeenCalled()
  })

  it('a task from before task worktrees comes back with a fresh worktree, its sessions carried into it', async () => {
    withStreams([relStream()])
    archive = withArchivedTasks(emptyArchive(), [archivedTask('old', {}, STREAM_WS.worktreePath)])
    api.taskWorktreeEnsure.mockResolvedValue({ status: 'ready', workspace: FRESH })
    const { result } = await mountState()

    await act(async () => { await result.current.reopenTask('p1', 'old') })

    expect(taskIn(result.current.projects[0], 'old')?.sharesStreamWorktree).toBeUndefined()
    expect(api.taskWorktreeEnsure).toHaveBeenCalledWith('p1', 'old', { name: 'old', streamId: 'stream-rel' })
    expect(api.taskMovePrepare).toHaveBeenCalledWith(
      STREAM_WS.worktreePath, FRESH.worktreePath, [{ kind: 'claude', sessionId: 'session-old' }], [], 'p1', undefined
    )
  })

  it('a task sharing its stream\'s worktree, or reopening into main, works in the stream\'s directory as before', async () => {
    withStreams([relStream()])
    archive = withArchivedTasks(emptyArchive(), [
      archivedTask('shared', { sharesStreamWorktree: true }, STREAM_WS.worktreePath),
      // Its stream is gone: it reopens in main, and its kept branch stays unused.
      archivedTask('orphan', { workspace: KEPT, landing: { state: 'conflict' } }, KEPT.worktreePath, 'stream-gone')
    ])
    const { result } = await mountState()

    await act(async () => { await result.current.reopenTask('p1', 'shared') })
    await act(async () => { await result.current.reopenTask('p1', 'orphan') })

    expect(api.taskWorktreeEnsure).not.toHaveBeenCalled()
    const orphan = taskIn(result.current.projects[0], 'orphan')
    expect(orphan?.workspace).toBeUndefined()
    expect(orphan?.landing).toBeUndefined()
    expect(api.taskMovePrepare).toHaveBeenCalledWith(KEPT.worktreePath, '/tmp/p1', [{ kind: 'claude', sessionId: 'session-orphan' }], [], 'p1', undefined)
  })

  it('a stream closed with Keep branches gets its worktree and each task\'s back, one task at a time', async () => {
    withStreams([])
    const stream: Stream = {
      id: 'stream-rel',
      name: 'rel',
      workspace: STREAM_WS,
      taskWorktrees: true,
      tasks: [
        { ...fixtureTask({ id: 'kept', name: 'kept', tabs: { left: [claudeTab('kept')] } }), workspace: KEPT },
        { ...fixtureTask({ id: 'gone', name: 'gone', tabs: { left: [claudeTab('gone')] } }), workspace: FRESH },
        fixtureTask({ id: 'idle', name: 'idle' })
      ]
    }
    archive = withArchivedStream(emptyArchive(), { stream, doneTasks: [], dir: STREAM_WS.worktreePath, archivedAt: 1 })
    api.workspaceRestore.mockResolvedValue({
      status: 'ok', worktreePath: STREAM_WS.worktreePath, branchName: 'rel', relativeProjectPath: '',
      setupPending: { repoKey: '/tmp/p1/.git', hash: 'h', commands: ['npm ci'] }
    })
    const fresh: WorkspaceConfig = { ...FRESH, worktreePath: '/tmp/p1/.worktrees/rel--gone', branchName: 'rel--gone' }
    let resolveKept: (value: unknown) => void = () => {}
    api.taskWorktreeEnsure.mockImplementation((_p: string, taskId: string) => (taskId === 'kept'
      ? new Promise(resolve => { resolveKept = resolve })
      : Promise.resolve({ status: 'ready', workspace: fresh })))
    const { result } = await mountState()

    let outcome: Awaited<ReturnType<typeof result.current.reopenStream>> | undefined
    let done: Promise<void> = Promise.resolve()
    act(() => { done = result.current.reopenStream('p1', 'stream-rel').then(value => { outcome = value }) })
    await waitFor(() => expect(api.taskWorktreeEnsure).toHaveBeenCalledTimes(1))
    // The second waits for the first's `git worktree add`.
    expect(api.taskWorktreeEnsure).toHaveBeenLastCalledWith('p1', 'kept', { name: 'kept', streamId: 'stream-rel' })
    await act(async () => {
      resolveKept({ status: 'ready', workspace: KEPT })
      await done
    })

    expect(api.taskWorktreeEnsure.mock.calls.map(call => call[1])).toEqual(['kept', 'gone'])
    // `idle` has nothing to spawn: it gets its worktree when it first needs one.
    expect(outcome?.setup).toEqual({ branch: 'rel', pending: { repoKey: '/tmp/p1/.git', hash: 'h', commands: ['npm ci'] } })
    const reopened = result.current.projects[0].streams.find(candidate => candidate.id === 'stream-rel')
    expect(reopened?.tasks.map(task => task.id)).toEqual(['kept', 'gone', 'idle'])
    // The branch that was gone: its sessions follow it into the fresh worktree.
    expect(api.taskMovePrepare).toHaveBeenCalledWith(FRESH.worktreePath, fresh.worktreePath, [{ kind: 'claude', sessionId: 'session-gone' }], [], 'p1', undefined)
  })
})

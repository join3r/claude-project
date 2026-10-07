// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, mainStreamId, type Project, type ProjectsData, type WorkspaceConfig } from '../src/shared/types'
import { emptyArchive, withArchivedStream, withArchivedTasks, withoutArchived, type ProjectArchive } from '../src/shared/archive'
import { useAppState } from '../src/renderer/hooks/useAppState'
import { resetArchiveStore } from '../src/renderer/hooks/archiveStore'
import { projectTasks } from '../src/shared/streams'
import { fixtureProject } from './helpers/streams-fixtures'

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
    loadProjects: vi.fn().mockResolvedValue({
      revision: 0,
      data: { projects: buildProjects(), tags: [], projectOrder: ['p1'], pinnedItems: [{ type: 'stream', projectId: 'p1', streamId: 'stream-w1' }] }
    }),
    loadConfig: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
    loadWindowState: vi.fn().mockResolvedValue(null),
    notesLoad: vi.fn().mockResolvedValue({ revision: 0, data: {} }),
    notesSave: vi.fn().mockResolvedValue({ ok: true, revision: 1 }),
    saveProjects: vi.fn().mockImplementation((_payload: { data: ProjectsData }) => Promise.resolve({ ok: true, revision: 1 })),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    saveWindowState: vi.fn().mockResolvedValue(undefined),
    getNativeTheme: vi.fn().mockResolvedValue('dark'),
    onThemeChanged: vi.fn(),
    onProjectsUpdated: vi.fn().mockReturnValue(() => {}),
    onNotesUpdated: vi.fn().mockReturnValue(() => {}),
    onTasksRemoved: vi.fn().mockReturnValue(() => {}),
    onTabsRemoved: vi.fn().mockReturnValue(() => {}),
    onTabsRestart: vi.fn().mockReturnValue(() => {}),
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
      WORKTREE.worktreePath, '/tmp/p1', [{ kind: 'claude', sessionId: 'bbbbbbbb-2222' }], [], undefined, undefined
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

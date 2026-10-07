// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  DEFAULT_CONFIG,
  isEphemeralProject,
  isSpentEphemeralProject,
  type Project,
  type ProjectsData
} from '../src/shared/types'
import { dirBasename } from '../src/shared/paths'
import { useAppState } from '../src/renderer/hooks/useAppState'
import { projectTasks } from '../src/shared/streams'
import { fixtureProject } from './helpers/streams-fixtures'

// React import is required by the JSX runtime under vitest's default transform.
void React

/**
 * "Use a directory…" in the composer files a task against a bare path. The hidden
 * project that owns it is an implementation detail: it must appear with the task,
 * be reused when the same path comes back, and disappear with the last real task.
 */

function buildProjects(): Project[] {
  return [fixtureProject({ id: 'p1', name: 'Project', directory: '/tmp/p1' })]
}

let saved: ProjectsData[]

beforeEach(() => {
  saved = []
  ;(window as any).api = {
    loadProjects: vi.fn().mockResolvedValue({
      revision: 0,
      data: { projects: buildProjects(), tags: [], projectOrder: ['p1'], pinnedItems: [] }
    }),
    loadConfig: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
    loadWindowState: vi.fn().mockResolvedValue(null),
    notesLoad: vi.fn().mockResolvedValue({ revision: 0, data: {} }),
    notesSave: vi.fn().mockResolvedValue({ ok: true, revision: 1 }),
    saveProjects: vi.fn().mockImplementation((payload: { data: ProjectsData }) => {
      saved.push(payload.data)
      return Promise.resolve({ ok: true, revision: saved.length })
    }),
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
    reportDirtyTabs: vi.fn().mockResolvedValue(undefined),
    sshStatus: vi.fn().mockResolvedValue('disconnected'),
    sshConnect: vi.fn().mockResolvedValue(undefined),
    sshDisconnect: vi.fn().mockResolvedValue(undefined),
    scrollbackDelete: vi.fn().mockResolvedValue(undefined),
    workspaceDelete: vi.fn().mockResolvedValue({ status: 'ok' }),
    archiveAddTasks: vi.fn().mockImplementation((_projectId: string, entries: unknown[]) =>
      Promise.resolve({ version: 1, tasks: entries, streams: [] }))
  }
})

afterEach(() => {
  cleanup()
})

async function mountState() {
  const hook = renderHook(() => useAppState())
  await waitFor(() => expect(hook.result.current.projects).toHaveLength(1))
  return hook
}

function adhoc(state: ReturnType<typeof useAppState>): Project | undefined {
  return state.projects.find(isEphemeralProject)
}

describe('dirBasename', () => {
  it('names a project after the folder, trailing slashes and all', () => {
    expect(dirBasename('/tmp/scratch')).toBe('scratch')
    expect(dirBasename('/tmp/scratch/')).toBe('scratch')
    expect(dirBasename('/')).toBe('/')
  })
})

describe('isSpentEphemeralProject', () => {
  it('only claims a hidden project with no task left', () => {
    expect(isSpentEphemeralProject(fixtureProject({ id: 'x', name: 'x', directory: '/d', ephemeral: true }))).toBe(true)
    expect(isSpentEphemeralProject(fixtureProject({ id: 'x', name: 'x', directory: '/d', ephemeral: true, tasks: [{ id: 't1' }] }))).toBe(false)
    // An ordinary empty project is the user's to keep.
    expect(isSpentEphemeralProject(fixtureProject({ id: 'x', name: 'x', directory: '/d' }))).toBe(false)
  })
})

describe('addTaskInDirectory', () => {
  it('mints the hidden project and the task in one write', async () => {
    const { result } = await mountState()

    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'Poke at it') })

    const project = adhoc(result.current)
    expect(project).toBeDefined()
    expect(project!.name).toBe('scratch')
    expect(project!.directory).toBe('/tmp/scratch')
    expect(result.current.projectOrder).toContain(project!.id)
    // Selected, so the composer's task is what you land on.
    expect(result.current.selectedProjectId).toBe(project!.id)

    // Never persisted in the empty state the storage sweep would delete.
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    for (const snapshot of saved) {
      for (const p of snapshot.projects.filter(isEphemeralProject)) {
        expect(projectTasks(p).length).toBeGreaterThan(0)
      }
    }
  })

  it('reuses the hidden project when the same directory comes back', async () => {
    const { result } = await mountState()

    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'First') })
    const firstId = adhoc(result.current)!.id
    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'Second') })

    expect(result.current.projects.filter(isEphemeralProject)).toHaveLength(1)
    const project = adhoc(result.current)!
    expect(project.id).toBe(firstId)
    expect(projectTasks(project).map(t => t.name)).toEqual(['First', 'Second'])
  })

  it('gives a different directory its own hidden project', async () => {
    const { result } = await mountState()

    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'First') })
    act(() => { result.current.addTaskInDirectory('/tmp/other', 'Second') })

    expect(result.current.projects.filter(isEphemeralProject).map(p => p.name)).toEqual(['scratch', 'other'])
  })
})

describe('archiveTask on an ad-hoc project', () => {
  it('retires the hidden project along with its last real task, writing no archive for it', async () => {
    const { result } = await mountState()

    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'Poke at it') })
    const project = adhoc(result.current)!
    const taskId = projectTasks(project)[0].id

    await act(async () => { await result.current.archiveTask(project.id, taskId) })

    expect(result.current.projects.filter(isEphemeralProject)).toHaveLength(0)
    expect(result.current.projectOrder).not.toContain(project.id)
    expect(result.current.selectedProjectId).toBeNull()
    expect((window as any).api.archiveAddTasks).not.toHaveBeenCalled()
  })

  it('keeps it while another real task is still there', async () => {
    const { result } = await mountState()

    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'First') })
    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'Second') })
    const project = adhoc(result.current)!
    const firstId = projectTasks(project).find(t => t.name === 'First')!.id

    await act(async () => { await result.current.archiveTask(project.id, firstId) })

    const still = adhoc(result.current)
    expect(still).toBeDefined()
    expect(projectTasks(still).map(t => t.name)).toEqual(['Second'])
    expect((window as any).api.archiveAddTasks).toHaveBeenCalledWith(project.id, [expect.objectContaining({ task: expect.objectContaining({ id: firstId }) })])
    expect(still!.streams[0].archivedTaskCount).toBe(1)
  })

  it('leaves an ordinary project standing when its last task goes', async () => {
    const { result } = await mountState()

    act(() => { result.current.addTask('p1', 'Only task') })
    const taskId = projectTasks(result.current.projects[0])[0].id

    await act(async () => { await result.current.archiveTask('p1', taskId) })

    expect(result.current.projects.map(p => p.id)).toContain('p1')
  })
})

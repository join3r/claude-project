// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  DEFAULT_CONFIG,
  createHomeTask,
  isEphemeralProject,
  isHomeTask,
  isSpentEphemeralProject,
  type Project,
  type ProjectsData
} from '../src/shared/types'
import { dirBasename } from '../src/shared/paths'
import { useAppState } from '../src/renderer/hooks/useAppState'

// React import is required by the JSX runtime under vitest's default transform.
void React

/**
 * "Use a directory…" in the composer files a task against a bare path. The hidden
 * project that owns it is an implementation detail: it must appear with the task,
 * be reused when the same path comes back, and disappear with the last real task.
 */

function buildProjects(): Project[] {
  const { task: home } = createHomeTask('p1')
  return [{ id: 'p1', name: 'Project', directory: '/tmp/p1', tasks: [home] }]
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
    onConfigUpdated: vi.fn().mockReturnValue(() => {}),
    reportDirtyTabs: vi.fn().mockResolvedValue(undefined),
    sshStatus: vi.fn().mockResolvedValue('disconnected'),
    sshConnect: vi.fn().mockResolvedValue(undefined),
    sshDisconnect: vi.fn().mockResolvedValue(undefined),
    scrollbackDelete: vi.fn().mockResolvedValue(undefined),
    workspaceDelete: vi.fn().mockResolvedValue({ status: 'ok' })
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
  const home = createHomeTask('x').task
  const real = { ...home, id: 't1', system: undefined }

  it('only claims a hidden project with nothing but its home task', () => {
    expect(isSpentEphemeralProject({ id: 'x', name: 'x', directory: '/d', ephemeral: true, tasks: [home] })).toBe(true)
    expect(isSpentEphemeralProject({ id: 'x', name: 'x', directory: '/d', ephemeral: true, tasks: [home, real] })).toBe(false)
    // An ordinary empty project is the user's to keep.
    expect(isSpentEphemeralProject({ id: 'x', name: 'x', directory: '/d', tasks: [home] })).toBe(false)
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
        expect(p.tasks.some(t => !isHomeTask(t))).toBe(true)
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
    expect(project.tasks.filter(t => !isHomeTask(t)).map(t => t.name)).toEqual(['First', 'Second'])
  })

  it('gives a different directory its own hidden project', async () => {
    const { result } = await mountState()

    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'First') })
    act(() => { result.current.addTaskInDirectory('/tmp/other', 'Second') })

    expect(result.current.projects.filter(isEphemeralProject).map(p => p.name)).toEqual(['scratch', 'other'])
  })

  it('carries a workspace through to the task', async () => {
    const { result } = await mountState()

    act(() => {
      result.current.addTaskInDirectory('/tmp/scratch', 'Isolated', [], {
        worktreePath: '/tmp/scratch/.worktrees/isolated',
        branchName: 'isolated',
        baseBranch: 'main',
        relativeProjectPath: ''
      })
    })

    const task = adhoc(result.current)!.tasks.find(t => !isHomeTask(t))!
    expect(task.workspace?.branchName).toBe('isolated')
  })
})

describe('removeTask on an ad-hoc project', () => {
  it('retires the hidden project along with its last real task', async () => {
    const { result } = await mountState()

    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'Poke at it') })
    const project = adhoc(result.current)!
    const taskId = project.tasks.find(t => !isHomeTask(t))!.id

    await act(async () => { await result.current.removeTask(project.id, taskId) })

    expect(result.current.projects.filter(isEphemeralProject)).toHaveLength(0)
    expect(result.current.projectOrder).not.toContain(project.id)
    expect(result.current.selectedProjectId).toBeNull()
  })

  it('keeps it while another real task is still there', async () => {
    const { result } = await mountState()

    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'First') })
    act(() => { result.current.addTaskInDirectory('/tmp/scratch', 'Second') })
    const project = adhoc(result.current)!
    const firstId = project.tasks.find(t => t.name === 'First')!.id

    await act(async () => { await result.current.removeTask(project.id, firstId) })

    const still = adhoc(result.current)
    expect(still).toBeDefined()
    expect(still!.tasks.filter(t => !isHomeTask(t)).map(t => t.name)).toEqual(['Second'])
  })

  it('leaves an ordinary project standing when its last task goes', async () => {
    const { result } = await mountState()

    act(() => { result.current.addTask('p1', 'Only task') })
    const taskId = result.current.projects[0].tasks.find(t => !isHomeTask(t))!.id

    await act(async () => { await result.current.removeTask('p1', taskId) })

    expect(result.current.projects.map(p => p.id)).toContain('p1')
  })
})

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, fireEvent, screen, act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, createHomeTask, type Project, type ProjectNote, type Task } from '../src/shared/types'
import { resolveLandingTaskId } from '../src/renderer/hooks/taskNavigation'
import { useAppState } from '../src/renderer/hooks/useAppState'

// React import is required by the JSX runtime under vitest's default transform.
void React

const appStub = vi.hoisted(() => ({ current: null as any }))
vi.mock('../src/renderer/context/AppContext', () => ({
  useApp: () => appStub.current
}))

import { Palette } from '../src/renderer/palette/Palette'

function task(id: string, name: string): Task {
  return {
    id,
    name,
    tabs: { left: [], right: [] },
    activeTab: { left: null, right: null },
    splitOpen: false,
    splitRatio: 0.5
  }
}

function note(id: string, name: string): ProjectNote {
  return { id, name, content: `content of ${name}`, createdAt: 1, updatedAt: 1 }
}

function buildProjects(): Project[] {
  const { task: homeA } = createHomeTask('proj-a')
  const { task: homeB } = createHomeTask('proj-b')
  return [
    {
      id: 'proj-a',
      name: 'Project A',
      directory: '/tmp/a',
      tasks: [homeA, task('task-a1', 'Task A1')],
      lastTaskId: 'task-a1'
    },
    {
      id: 'proj-b',
      name: 'Project B',
      directory: '/tmp/b',
      tasks: [homeB, task('task-b1', 'Task B1')],
      lastTaskId: 'task-b1'
    }
  ]
}

const NOTES: Record<string, ProjectNote[]> = {
  'proj-a': [note('note-a', 'Alpha Note')],
  'proj-b': [note('note-b', 'Beta Note')]
}

describe('resolveLandingTaskId', () => {
  it('keeps a requested task that belongs to the project', () => {
    const [projectA] = buildProjects()
    expect(resolveLandingTaskId(projectA, 'task-a1')).toBe('task-a1')
  })

  it('falls back to the project lastTaskId for a foreign or missing task', () => {
    const [, projectB] = buildProjects()
    expect(resolveLandingTaskId(projectB, 'task-a1')).toBe('task-b1')
    expect(resolveLandingTaskId(projectB, null)).toBe('task-b1')
    expect(resolveLandingTaskId(projectB, 'deleted-task')).toBe('task-b1')
  })

  it('falls back to the home task when lastTaskId is stale', () => {
    const [, projectB] = buildProjects()
    const withoutLast: Project = { ...projectB, lastTaskId: 'gone' }
    const homeId = projectB.tasks.find(t => t.system === 'home')!.id
    expect(resolveLandingTaskId(withoutLast, 'task-a1')).toBe(homeId)
  })

  it('returns null for a missing project', () => {
    expect(resolveLandingTaskId(undefined, 'task-a1')).toBeNull()
  })
})

describe('Palette note selection', () => {
  let openOrFocusNoteTab: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openOrFocusNoteTab = vi.fn()
    appStub.current = {
      projects: buildProjects(),
      notes: NOTES,
      pinnedItems: [],
      config: DEFAULT_CONFIG,
      selectedProjectId: 'proj-a',
      selectedTaskId: 'task-a1',
      effectiveTheme: 'dark' as const,
      openOrFocusNoteTab,
      switchToTask: vi.fn(),
      setActiveTab: vi.fn(),
      selectProjectHome: vi.fn()
    }
    ;(window as any).api = {
      paletteFrecencyLoad: vi.fn().mockResolvedValue({ version: 1, entries: {} }),
      paletteFrecencySave: vi.fn().mockResolvedValue(undefined)
    }
  })

  afterEach(() => {
    cleanup()
  })

  async function openPaletteAndSearch(query: string) {
    render(<Palette />)
    await act(async () => { fireEvent.keyDown(window, { key: 'k', metaKey: true }) })
    const input = screen.getByPlaceholderText('type to search…') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { value: query } }) })
    return input
  }

  it('passes no task id for a note owned by another project', async () => {
    const input = await openPaletteAndSearch('#*Beta')
    // The row is labelled with its owning project (title text is split by match highlighting).
    expect(screen.getByText('Project B')).toBeTruthy()
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(openOrFocusNoteTab).toHaveBeenCalledWith('proj-b', null, 'left', 'note-b')
  })

  it('still passes the selected task id for a note in the current project', async () => {
    const input = await openPaletteAndSearch('#Alpha')
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(openOrFocusNoteTab).toHaveBeenCalledWith('proj-a', 'task-a1', 'left', 'note-a')
  })
})

describe('openOrFocusNoteTab navigation', () => {
  beforeEach(() => {
    ;(window as any).api = {
      loadProjects: vi.fn().mockResolvedValue({
        revision: 0,
        data: { projects: buildProjects(), tags: [], projectOrder: [], pinnedItems: [] }
      }),
      loadConfig: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
      loadWindowState: vi.fn().mockResolvedValue(null),
      notesLoad: vi.fn().mockResolvedValue({ revision: 0, data: NOTES }),
      notesSave: vi.fn().mockResolvedValue({ ok: true, revision: 1 }),
      saveProjects: vi.fn().mockResolvedValue({ ok: true, revision: 1 }),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      saveWindowState: vi.fn().mockResolvedValue(undefined),
      getNativeTheme: vi.fn().mockResolvedValue('dark'),
      onThemeChanged: vi.fn(),
      onProjectsUpdated: vi.fn().mockReturnValue(() => {}),
      onNotesUpdated: vi.fn().mockReturnValue(() => {}),
      onTasksRemoved: vi.fn().mockReturnValue(() => {}),
      reportDirtyTabs: vi.fn().mockResolvedValue(undefined),
      onConfigUpdated: vi.fn().mockReturnValue(() => {}),
      sshStatus: vi.fn().mockResolvedValue('disconnected'),
      sshConnect: vi.fn().mockResolvedValue(undefined),
      sshDisconnect: vi.fn().mockResolvedValue(undefined),
      scrollbackDelete: vi.fn().mockResolvedValue(undefined),
      workspaceDelete: vi.fn().mockResolvedValue({ status: 'ok' })
    }
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  async function mountState() {
    const hook = renderHook(() => useAppState())
    await waitFor(() => expect(hook.result.current.projects).toHaveLength(2))
    return hook
  }

  function noteTabsFor(state: ReturnType<typeof useAppState>, projectId: string, taskId: string) {
    const target = state.projects.find(p => p.id === projectId)?.tasks.find(t => t.id === taskId)
    return (target?.tabs.left ?? []).filter(tab => tab.type === 'note')
  }

  it('switches to the target project and opens a cross-project note', async () => {
    const { result } = await mountState()

    act(() => { result.current.switchToTask('proj-a', 'task-a1') })
    expect(result.current.selectedProjectId).toBe('proj-a')

    // The palette passes null here; a stale foreign id must be tolerated too.
    act(() => { result.current.openOrFocusNoteTab('proj-b', null, 'left', 'note-b') })

    expect(result.current.selectedProjectId).toBe('proj-b')
    expect(result.current.selectedTaskId).toBe('task-b1')
    const tabs = noteTabsFor(result.current, 'proj-b', 'task-b1')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].noteId).toBe('note-b')
    expect(result.current.exportWindowViewState().taskStates['task-b1'].activeTab.left).toBe(tabs[0].id)
    // Project A is untouched.
    expect(noteTabsFor(result.current, 'proj-a', 'task-a1')).toHaveLength(0)
  })

  it('tolerates a task id belonging to another project', async () => {
    const { result } = await mountState()

    act(() => { result.current.switchToTask('proj-a', 'task-a1') })
    act(() => { result.current.openOrFocusNoteTab('proj-b', 'task-a1', 'left', 'note-b') })

    expect(result.current.selectedProjectId).toBe('proj-b')
    expect(result.current.selectedTaskId).toBe('task-b1')
    expect(noteTabsFor(result.current, 'proj-b', 'task-b1')).toHaveLength(1)
  })

  it('opens a note whose requested task no longer exists instead of doing nothing', async () => {
    const { result } = await mountState()

    act(() => { result.current.switchToTask('proj-a', 'task-a1') })
    act(() => { result.current.openOrFocusNoteTab('proj-a', 'deleted-task', 'left', 'note-a') })

    expect(result.current.selectedProjectId).toBe('proj-a')
    expect(result.current.selectedTaskId).toBe('task-a1')
    const tabs = noteTabsFor(result.current, 'proj-a', 'task-a1')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].noteId).toBe('note-a')
  })

  it('opens a same-project note in the selected task and refocuses it instead of duplicating', async () => {
    const { result } = await mountState()

    act(() => { result.current.switchToTask('proj-a', 'task-a1') })
    act(() => { result.current.openOrFocusNoteTab('proj-a', 'task-a1', 'left', 'note-a') })

    const tabs = noteTabsFor(result.current, 'proj-a', 'task-a1')
    expect(tabs).toHaveLength(1)
    const tabId = tabs[0].id

    // Move focus elsewhere, then re-open: the existing tab is focused, not cloned.
    act(() => { result.current.addTab('proj-a', 'task-a1', 'left', 'terminal') })
    expect(result.current.exportWindowViewState().taskStates['task-a1'].activeTab.left).not.toBe(tabId)

    act(() => { result.current.openOrFocusNoteTab('proj-a', 'task-a1', 'left', 'note-a') })
    expect(result.current.selectedProjectId).toBe('proj-a')
    expect(result.current.selectedTaskId).toBe('task-a1')
    expect(noteTabsFor(result.current, 'proj-a', 'task-a1')).toHaveLength(1)
    expect(result.current.exportWindowViewState().taskStates['task-a1'].activeTab.left).toBe(tabId)
  })
})

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  DEFAULT_CONFIG,
  type Project,
  type ProjectsData,
  type Task
} from '../src/shared/types'
import { findTaskInProject, taskTabs } from '../src/shared/streams'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'
import { useAppStateCore, usePersistence } from '../src/renderer/hooks/appState/useAppStateCore'
import { useTaskInbox } from '../src/renderer/hooks/appState/useTaskInbox'
import { useTabs } from '../src/renderer/hooks/appState/useTabs'
import { useWindowLayout } from '../src/renderer/hooks/appState/useWindowLayout'
import { useZoom } from '../src/renderer/hooks/appState/useZoom'
import { useDirtyClosePrompt } from '../src/renderer/hooks/appState/useDirtyClosePrompt'
import { DirtyBufferProvider, useDirtyBufferStore } from '../src/renderer/context/DirtyBufferContext'

// React import is required by the JSX runtime under vitest's default transform.
void React

/**
 * Each domain hook is mounted on top of the real core (load, sync, mutation
 * wrappers) but without the rest of `useAppState`, to show the split holds:
 * a domain only needs the core and whatever it is handed explicitly.
 */

const WORK_TASK: Task = fixtureTask({
  id: 't1',
  name: 'Work',
  tabs: { left: [{ id: 'a', type: 'terminal', title: 'A' }] }
})

function buildProjects(): Project[] {
  const project = fixtureProject({ id: 'p1', name: 'Project', directory: '/tmp/p1' })
  project.streams[0].tasks.push(WORK_TASK)
  return [project]
}

/** The work task `t1` as it stands in `data`. */
function workTask(data: ProjectsData): Task {
  return findTaskInProject(data.projects[0], 't1')!
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
    onProjectsUpdated: vi.fn().mockReturnValue(() => {}),
    onNotesUpdated: vi.fn().mockReturnValue(() => {}),
    onConfigUpdated: vi.fn().mockReturnValue(() => {}),
    reportDirtyTabs: vi.fn().mockResolvedValue(undefined),
    sshStatus: vi.fn().mockResolvedValue('disconnected'),
    sshConnect: vi.fn().mockResolvedValue(undefined),
    scrollbackDelete: vi.fn().mockResolvedValue(undefined)
  }
})

afterEach(() => {
  cleanup()
})

async function loaded<T extends { core: ReturnType<typeof useAppStateCore> }>(hook: { result: { current: T } }) {
  await waitFor(() => expect(hook.result.current.core.projectsData.projects).toHaveLength(1))
}

const alwaysProceed = () => Promise.resolve('proceed' as const)

describe('useTaskInbox', () => {
  it('reads an event on arrival only for the task on screen', async () => {
    const hook = renderHook(() => {
      const core = useAppStateCore()
      return { core, inbox: useTaskInbox(core) }
    })
    await loaded(hook)

    act(() => { hook.result.current.inbox.markTaskEvent('p1', 't1', 'attention') })
    let inbox = workTask(hook.result.current.core.projectsData).inbox
    expect(inbox?.attentionAt).toBeTypeOf('number')
    expect(inbox?.visitedAt).toBeUndefined()

    act(() => {
      hook.result.current.core.updateWindowViewState(prev => ({ ...prev, selectedProjectId: 'p1', selectedTaskId: 't1' }))
    })
    act(() => { hook.result.current.inbox.markTaskEvent('p1', 't1') })
    inbox = workTask(hook.result.current.core.projectsData).inbox
    expect(inbox?.visitedAt).toBe(inbox?.eventAt)
  })

  it('settle is saved once persistence is mounted', async () => {
    const hook = renderHook(() => {
      const core = useAppStateCore()
      usePersistence(core)
      return { core, inbox: useTaskInbox(core) }
    })
    await loaded(hook)
    act(() => { hook.result.current.inbox.settleTask('p1', 't1') })
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(workTask(saved[saved.length - 1]).inbox?.settledAt).toBeTypeOf('number')
  })
})

describe('useTabs', () => {
  function mountTabs() {
    return renderHook(() => {
      const core = useAppStateCore()
      const tabs = useTabs(core, { connectSsh: vi.fn(), confirmDiscardDirty: alwaysProceed })
      return { core, tabs }
    })
  }

  it('adds a tab and makes it active in its pane', async () => {
    const hook = mountTabs()
    await loaded(hook)

    let tabId = ''
    act(() => { tabId = hook.result.current.tabs.addTab('p1', 't1', 0, 'terminal').id })

    const task = workTask(hook.result.current.core.projectsData)
    expect(task.panes).toHaveLength(1)
    expect(task.panes[0].tabs.map(t => t.id)).toEqual(['a', tabId])
    expect(task.panes[0].activeTabId).toBe(tabId)
  })

  it('splits a tab off to the right, then closes the pane its last tab leaves', async () => {
    const hook = mountTabs()
    await loaded(hook)

    let tabId = ''
    act(() => { tabId = hook.result.current.tabs.addTab('p1', 't1', 0, 'terminal').id })
    act(() => { hook.result.current.tabs.splitTabRight('p1', 't1', tabId) })
    let task = workTask(hook.result.current.core.projectsData)
    expect(task.panes.map(pane => pane.tabs.map(t => t.id))).toEqual([['a'], [tabId]])
    expect(task.panes.map(pane => pane.width)).toEqual([0.5, 0.5])

    act(() => { hook.result.current.tabs.moveTab('p1', 't1', tabId, { kind: 'tab', pane: 0, index: 0 }) })
    task = workTask(hook.result.current.core.projectsData)
    expect(task.panes.map(pane => pane.tabs.map(t => t.id))).toEqual([[tabId, 'a']])
    expect(task.panes[0]).toMatchObject({ activeTabId: tabId, width: 1 })
  })

  it('reopens a closed tab where it was', async () => {
    const hook = mountTabs()
    await loaded(hook)

    let added = ''
    act(() => { added = hook.result.current.tabs.addTab('p1', 't1', 0, 'terminal').id })
    // The main tab closes only with its task.
    expect(workTask(hook.result.current.core.projectsData).mainTabId).toBe('a')
    await act(async () => { await hook.result.current.tabs.removeTab('p1', 't1', 'a') })
    expect(taskTabs(workTask(hook.result.current.core.projectsData)).map(t => t.id)).toContain('a')

    await act(async () => { await hook.result.current.tabs.removeTab('p1', 't1', added) })
    expect(taskTabs(workTask(hook.result.current.core.projectsData)).map(t => t.id)).not.toContain(added)

    let pane: number | null = null
    act(() => { pane = hook.result.current.tabs.reopenClosedTab() })
    expect(pane).toBe(0)
    const task = workTask(hook.result.current.core.projectsData)
    expect(task.panes[0].tabs.map(t => t.id)).toEqual(['a', added])
    expect(task.panes[0].activeTabId).toBe(added)
    expect(hook.result.current.core.windowViewState).toMatchObject({ selectedProjectId: 'p1', selectedTaskId: 't1' })
  })

  it('focuses an existing editor tab instead of opening a second one', async () => {
    const hook = mountTabs()
    await loaded(hook)

    act(() => { hook.result.current.tabs.openOrFocusEditorTab('p1', 't1', 0, 'src/a.ts') })
    act(() => { hook.result.current.tabs.setActiveTab('p1', 't1', 'a') })
    act(() => { hook.result.current.tabs.openOrFocusEditorTab('p1', 't1', 'focused', 'src/a.ts') })

    const task = workTask(hook.result.current.core.projectsData)
    const editors = taskTabs(task).filter(t => t.type === 'editor')
    expect(editors).toHaveLength(1)
    expect(task.panes[0].activeTabId).toBe(editors[0].id)
  })
})

describe('useWindowLayout', () => {
  it('clamps widths and remembers the file browser per task', async () => {
    const hook = renderHook(() => {
      const core = useAppStateCore()
      return { core, layout: useWindowLayout(core) }
    })
    await loaded(hook)

    act(() => { hook.result.current.layout.setSidebarWidth(10) })
    act(() => { hook.result.current.layout.setFileBrowserWidth(9999) })
    expect(hook.result.current.layout.sidebarWidth).toBe(180)
    expect(hook.result.current.layout.fileBrowserWidth).toBe(400)

    act(() => {
      hook.result.current.core.updateWindowViewState(prev => ({ ...prev, selectedProjectId: 'p1', selectedTaskId: 't1', fileBrowserOpen: false }))
    })
    act(() => { hook.result.current.layout.toggleFileBrowser() })
    expect(hook.result.current.layout.fileBrowserOpen).toBe(true)
    expect(hook.result.current.core.windowViewState.taskStates.t1.fileBrowserOpen).toBe(true)
  })
})

describe('useZoom', () => {
  it('bounds the terminal delta by the configured font size', () => {
    const hook = renderHook(({ fontSize }) => useZoom(fontSize), { initialProps: { fontSize: 44 as number | undefined } })
    act(() => { hook.result.current.zoomTerminal('in') })
    act(() => { hook.result.current.zoomTerminal('in') })
    expect(hook.result.current.terminalZoomDelta).toBe(4)
    act(() => { hook.result.current.zoomTerminal('in') })
    expect(hook.result.current.terminalZoomDelta).toBe(4)

    act(() => { hook.result.current.zoomBrowser('out') })
    expect(hook.result.current.browserZoomFactor).toBe(0.9)
  })
})

describe('useDirtyClosePrompt', () => {
  it('asks only when a tab is dirty, and discard lets the removal proceed', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <DirtyBufferProvider>{children}</DirtyBufferProvider>
    const hook = renderHook(() => ({ dirty: useDirtyClosePrompt(), store: useDirtyBufferStore() }), { wrapper })

    await expect(hook.result.current.dirty.confirmDiscardDirty(['clean'])).resolves.toBe('proceed')

    act(() => {
      hook.result.current.store.registerBuffer('tab1', { filePath: 'a.ts', isDirty: true, save: () => Promise.resolve() })
    })
    let outcome: Promise<'proceed' | 'cancel'> | null = null
    act(() => { outcome = hook.result.current.dirty.confirmDiscardDirty(['tab1']) })
    expect(hook.result.current.dirty.dirtyPrompt).toEqual({ files: ['a.ts'], saving: false, error: null })

    await act(async () => { await hook.result.current.dirty.resolveDirtyPrompt('discard') })
    await expect(outcome!).resolves.toBe('proceed')
    expect(hook.result.current.dirty.dirtyPrompt).toBeNull()
  })

  it('keeps the dialog up with the reason when a save fails', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <DirtyBufferProvider>{children}</DirtyBufferProvider>
    const hook = renderHook(() => ({ dirty: useDirtyClosePrompt(), store: useDirtyBufferStore() }), { wrapper })

    act(() => {
      hook.result.current.store.registerBuffer('tab1', { filePath: 'a.ts', isDirty: true, save: () => Promise.reject(new Error('disk full')) })
    })
    act(() => { void hook.result.current.dirty.confirmDiscardDirty(['tab1']) })
    await act(async () => { await hook.result.current.dirty.resolveDirtyPrompt('save') })
    expect(hook.result.current.dirty.dirtyPrompt).toMatchObject({ saving: false, error: 'Save failed: disk full' })
  })
})

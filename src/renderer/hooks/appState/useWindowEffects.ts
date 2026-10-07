/**
 * The effects that tie this window's view state to the world around it: the OS
 * theme and focus, main's own task removals, and the selection-driven syncs
 * (tag filter pruning, `lastTaskId` stamping, SSH auto-connect, per-task
 * file-browser restore). Each is its own hook so `useAppState` can keep them in
 * their original order.
 */
import { useState, useEffect, useRef } from 'react'
import { reconcileWindowViewState } from '../../../shared/types'
import type { Project, Task } from '../../../shared/types'
import { persistSelectionState } from '../stateHydration'
import type { AppStateCore, UpdateWindowViewState } from './useAppStateCore'
import { forgetRemovedTaskView, sidebarForTask } from './viewState'
import { ensureRemoteConnected, type ConnectSsh } from './remote'
import { buildWindowTitle } from './windowTitle'
import { findTaskInProject } from '../../../shared/streams'

export function useNativeTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  useEffect(() => {
    void window.api.getNativeTheme().then(setTheme)
    window.api.onThemeChanged(setTheme)
  }, [])
  return theme
}

/**
 * Main deleted a task by itself (idle cleanup). The state change arrives as a
 * normal projects broadcast; this is the part of `removeTask` that is local to
 * a window — the xterm instances and per-tab status entries hanging off the
 * tabs, and this window's own view state.
 */
export function useTasksRemovedListener(updateWindowViewState: UpdateWindowViewState): void {
  useEffect(() => {
    return window.api.onTasksRemoved(({ taskId, tabIds }) => {
      for (const tabId of tabIds) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
      }
      // Disposing a live xterm writes its buffer back synchronously, which would
      // put back the scrollback file main just deleted.
      for (const tabId of tabIds) {
        void window.api.scrollbackDelete(tabId)
      }
      updateWindowViewState(prev => forgetRemovedTaskView(prev, taskId))
    })
  }, [updateWindowViewState])
}

/**
 * Main closed a tab by itself (the phone's `tab.close`). As for a task: the xterm
 * and status entries go here, and the projects broadcast drops the tab.
 */
export function useTabsRemovedListener(): void {
  useEffect(() => {
    return window.api.onTabsRemoved(({ tabIds }) => {
      for (const tabId of tabIds) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
      }
      for (const tabId of tabIds) {
        void window.api.scrollbackDelete(tabId)
      }
    })
  }, [])
}

export function useWindowFocused(): boolean {
  const [windowFocused, setWindowFocused] = useState(() => (typeof document === 'undefined' ? true : document.hasFocus()))
  useEffect(() => {
    const handleFocus = () => setWindowFocused(true)
    const handleBlur = () => setWindowFocused(false)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
    }
  }, [])
  return windowFocused
}

export function useSelectionSync(core: AppStateCore, windowFocused: boolean, connectSsh: ConnectSsh): void {
  const {
    projectsData, config, setConfig, windowViewState,
    projectsLoadedRef, configLoadedRef, mutateProjects, updateWindowViewState
  } = core
  const { projects, tags } = projectsData

  useEffect(() => {
    const tagIds = new Set(tags.map(tag => tag.id))
    updateWindowViewState((prev) => {
      const filtered = prev.selectedTagIds.filter(id => tagIds.has(id))
      if (filtered.length === prev.selectedTagIds.length) return prev
      return reconcileWindowViewState(
        { ...prev, selectedTagIds: filtered },
        projects,
        tagIds
      )
    })
  }, [tags, projects, updateWindowViewState])

  useEffect(() => {
    if (!projectsLoadedRef.current || !configLoadedRef.current || !config) return
    if (!windowFocused) return

    const selectedProjectId = windowViewState.selectedProjectId
    const selectedTaskId = windowViewState.selectedTaskId
    const selection = persistSelectionState(projectsData, config, selectedProjectId, selectedTaskId)

    // Stamping the project's `lastTaskId` is a real mutation of shared state, so it
    // goes through the wrapper like any other — recomputed against `prev` so that a
    // conflict replay stamps the right project rather than a stale snapshot of it.
    if (selection.projectsData !== projectsData) {
      mutateProjects(prev => persistSelectionState(prev, config, selectedProjectId, selectedTaskId).projectsData)
    }

    if (selection.config !== config) {
      setConfig(selection.config)
    }
  }, [
    config,
    mutateProjects,
    projectsData,
    windowFocused,
    windowViewState.selectedProjectId,
    windowViewState.selectedTaskId
  ])

  useEffect(() => {
    const selectedProjectId = windowViewState.selectedProjectId
    if (!selectedProjectId || projects.length === 0) return
    const project = projects.find(p => p.id === selectedProjectId)
    ensureRemoteConnected(selectedProjectId, project, connectSsh)
  }, [connectSsh, projects, windowViewState.selectedProjectId])

  const lastSyncedSidebarTaskIdRef = useRef<string | null>(null)
  useEffect(() => {
    const taskId = windowViewState.selectedTaskId
    if (!taskId) {
      lastSyncedSidebarTaskIdRef.current = null
      return
    }
    if (lastSyncedSidebarTaskIdRef.current === taskId) return
    const project = projects.find(p => !!findTaskInProject(p, taskId))
    const task = findTaskInProject(project, taskId) ?? null
    if (!task) return
    lastSyncedSidebarTaskIdRef.current = taskId

    const next = sidebarForTask(windowViewState, task)
    if (next.fileBrowserOpen === windowViewState.fileBrowserOpen && next.fileBrowserActiveTab === windowViewState.fileBrowserActiveTab) return
    updateWindowViewState(prev => ({
      ...prev,
      fileBrowserOpen: next.fileBrowserOpen,
      fileBrowserActiveTab: next.fileBrowserActiveTab
    }))
  }, [projects, windowViewState.selectedTaskId, windowViewState.taskStates, windowViewState.fileBrowserOpen, windowViewState.fileBrowserActiveTab, updateWindowViewState])
}

export function useWindowTitle(selectedProject: Project | null, selectedTask: Task | null): void {
  useEffect(() => {
    document.title = buildWindowTitle(selectedProject?.name ?? null, selectedTask?.name ?? null)
  }, [selectedProject?.name, selectedTask?.name])
}

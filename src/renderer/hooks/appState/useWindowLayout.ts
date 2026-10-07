import { useCallback } from 'react'
import { cloneWindowViewState } from '../../../shared/types'
import type { FileBrowserTab, SidebarTab, WindowViewState } from '../../../shared/types'
import type { AppStateCore } from './useAppStateCore'
import {
  clampFileBrowserWidth,
  clampSidebarWidth,
  setProjectExpandedView,
  toggleId,
  writeSidebarToTask,
  type SidebarPatch
} from './viewState'
import { findTaskInProject } from '../../../shared/streams'

const EMPTY_EXPANSION: Record<string, boolean> = {}

export interface WindowLayoutActions {
  expandedProjectIds: string[]
  toggleProjectExpansion: (projectId: string) => void
  setProjectExpanded: (projectId: string, expanded: boolean) => void
  /** Streams opened or closed by hand in this window; see `WindowViewState.streamExpansion`. */
  streamExpansion: Record<string, boolean>
  setStreamExpanded: (streamId: string, expanded: boolean) => void
  /** Forget every hand-set stream, so all follow the auto-collapse setting again. */
  clearStreamExpansion: () => void
  /** A detached copy of this window's view state, for handing to a new window. */
  exportWindowViewState: () => WindowViewState
  fileBrowserOpen: boolean
  fileBrowserWidth: number
  fileBrowserActiveTab: FileBrowserTab
  toggleFileBrowser: () => void
  setFileBrowserOpen: (open: boolean) => void
  setFileBrowserWidth: (width: number) => void
  setFileBrowserActiveTab: (tab: FileBrowserTab) => void
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  sidebarProjectsCollapsed: boolean
  toggleSidebarProjectsCollapsed: () => void
  sidebarTab: SidebarTab
  setSidebarTab: (tab: SidebarTab) => void
}

/** Window chrome: sidebar expansion and widths, the file browser. */
export function useWindowLayout(core: AppStateCore): WindowLayoutActions {
  const { windowViewState, windowViewStateRef, projectsRef, updateWindowViewState } = core

  const toggleProjectExpansion = useCallback((projectId: string) => {
    updateWindowViewState(prev => ({ ...prev, expandedProjectIds: toggleId(prev.expandedProjectIds, projectId) }))
  }, [updateWindowViewState])

  const setProjectExpanded = useCallback((projectId: string, expanded: boolean) => {
    updateWindowViewState(prev => setProjectExpandedView(prev, projectId, expanded))
  }, [updateWindowViewState])

  const setStreamExpanded = useCallback((streamId: string, expanded: boolean) => {
    updateWindowViewState(prev => (
      prev.streamExpansion?.[streamId] === expanded
        ? prev
        : { ...prev, streamExpansion: { ...prev.streamExpansion, [streamId]: expanded } }
    ))
  }, [updateWindowViewState])

  const clearStreamExpansion = useCallback(() => {
    updateWindowViewState(prev => {
      if (!prev.streamExpansion) return prev
      const { streamExpansion: _cleared, ...rest } = prev
      return rest
    })
  }, [updateWindowViewState])

  const exportWindowViewState = useCallback(() => cloneWindowViewState(windowViewStateRef.current), [])

  const writeSidebarToCurrentTask = useCallback((prev: WindowViewState, patch: SidebarPatch): WindowViewState => {
    const taskId = prev.selectedTaskId
    const project = taskId ? projectsRef.current.find(p => !!findTaskInProject(p, taskId)) : null
    const task = project && taskId ? findTaskInProject(project, taskId) ?? null : null
    return writeSidebarToTask(prev, task, patch)
  }, [])

  const toggleFileBrowser = useCallback(() => {
    updateWindowViewState(prev => writeSidebarToCurrentTask(prev, { fileBrowserOpen: !prev.fileBrowserOpen }))
  }, [updateWindowViewState, writeSidebarToCurrentTask])

  const setFileBrowserWidth = useCallback((width: number) => {
    updateWindowViewState(prev => ({ ...prev, fileBrowserWidth: clampFileBrowserWidth(width) }))
  }, [updateWindowViewState])

  const setSidebarWidth = useCallback((width: number) => {
    updateWindowViewState(prev => ({ ...prev, sidebarWidth: clampSidebarWidth(width) }))
  }, [updateWindowViewState])

  const toggleSidebarProjectsCollapsed = useCallback(() => {
    updateWindowViewState(prev => ({ ...prev, sidebarProjectsCollapsed: !prev.sidebarProjectsCollapsed }))
  }, [updateWindowViewState])

  const setSidebarTab = useCallback((tab: SidebarTab) => {
    updateWindowViewState(prev => ({ ...prev, sidebarTab: tab }))
  }, [updateWindowViewState])

  const setFileBrowserOpen = useCallback((open: boolean) => {
    updateWindowViewState(prev => writeSidebarToCurrentTask(prev, { fileBrowserOpen: open }))
  }, [updateWindowViewState, writeSidebarToCurrentTask])

  const setFileBrowserActiveTab = useCallback((tab: FileBrowserTab) => {
    updateWindowViewState(prev => writeSidebarToCurrentTask(prev, { fileBrowserActiveTab: tab }))
  }, [updateWindowViewState, writeSidebarToCurrentTask])

  return {
    expandedProjectIds: windowViewState.expandedProjectIds,
    toggleProjectExpansion,
    setProjectExpanded,
    streamExpansion: windowViewState.streamExpansion ?? EMPTY_EXPANSION,
    setStreamExpanded,
    clearStreamExpansion,
    exportWindowViewState,
    fileBrowserOpen: windowViewState.fileBrowserOpen,
    fileBrowserWidth: windowViewState.fileBrowserWidth,
    fileBrowserActiveTab: windowViewState.fileBrowserActiveTab,
    toggleFileBrowser,
    setFileBrowserOpen,
    setFileBrowserWidth,
    setFileBrowserActiveTab,
    sidebarWidth: windowViewState.sidebarWidth,
    setSidebarWidth,
    sidebarProjectsCollapsed: windowViewState.sidebarProjectsCollapsed,
    toggleSidebarProjectsCollapsed,
    sidebarTab: windowViewState.sidebarTab,
    setSidebarTab
  }
}

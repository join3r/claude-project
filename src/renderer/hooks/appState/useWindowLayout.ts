import { useCallback } from 'react'
import { cloneWindowViewState } from '../../../shared/types'
import type { DeskViewState, FileBrowserTab, WindowViewState } from '../../../shared/types'
import type { AppStateCore } from './useAppStateCore'
import { clampFileBrowserWidth, writeSidebarToTask, type SidebarPatch } from './viewState'
import { findTaskInProject } from '../../../shared/streams'

export interface WindowLayoutActions {
  /** A detached copy of this window's view state, for handing to a new window. */
  exportWindowViewState: () => WindowViewState
  fileBrowserOpen: boolean
  fileBrowserWidth: number
  fileBrowserActiveTab: FileBrowserTab
  toggleFileBrowser: () => void
  setFileBrowserOpen: (open: boolean) => void
  setFileBrowserWidth: (width: number) => void
  setFileBrowserActiveTab: (tab: FileBrowserTab) => void
  /** The desk's column in this window: width, tab, scope. */
  desk: DeskViewState
  updateDesk: (patch: Partial<DeskViewState>) => void
}

const EMPTY_DESK: DeskViewState = {}

/** Window chrome: the inbox column's state, the file browser. */
export function useWindowLayout(core: AppStateCore): WindowLayoutActions {
  const { windowViewState, windowViewStateRef, projectsRef, updateWindowViewState } = core

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

  const updateDesk = useCallback((patch: Partial<DeskViewState>) => {
    updateWindowViewState(prev => ({ ...prev, desk: { ...prev.desk, ...patch } }))
  }, [updateWindowViewState])

  const setFileBrowserOpen = useCallback((open: boolean) => {
    updateWindowViewState(prev => writeSidebarToCurrentTask(prev, { fileBrowserOpen: open }))
  }, [updateWindowViewState, writeSidebarToCurrentTask])

  const setFileBrowserActiveTab = useCallback((tab: FileBrowserTab) => {
    updateWindowViewState(prev => writeSidebarToCurrentTask(prev, { fileBrowserActiveTab: tab }))
  }, [updateWindowViewState, writeSidebarToCurrentTask])

  return {
    exportWindowViewState,
    fileBrowserOpen: windowViewState.fileBrowserOpen,
    fileBrowserWidth: windowViewState.fileBrowserWidth,
    fileBrowserActiveTab: windowViewState.fileBrowserActiveTab,
    toggleFileBrowser,
    setFileBrowserOpen,
    setFileBrowserWidth,
    setFileBrowserActiveTab,
    desk: windowViewState.desk ?? EMPTY_DESK,
    updateDesk
  }
}

import { useCallback } from 'react'
import type { AppStateCore } from './useAppStateCore'
import { ensureRemoteConnected, type ConnectSsh } from './remote'
import { selectProjectHomeView, selectProjectView, switchToTaskView } from './viewState'

export interface SelectionActions {
  /** Select a project (restoring its last task), or clear the selection with `null`. */
  setSelectedProjectId: (id: string | null) => void
  /** Open the project's Home page (the project with no task selected). */
  selectProjectHome: (projectId: string) => void
  setSelectedTaskId: (id: string | null) => void
  switchToTask: (projectId: string, taskId: string) => void
}

/** Which project and task this window is looking at. Landing on a remote project connects it. */
export function useSelection(
  core: AppStateCore,
  connectSsh: ConnectSsh,
  markTaskVisited: (projectId: string, taskId: string) => void
): SelectionActions {
  const { projectsRef, updateWindowViewState } = core

  const selectProject = useCallback((id: string | null) => {
    updateWindowViewState(prev => {
      const project = id ? projectsRef.current.find(candidate => candidate.id === id) ?? null : null
      return selectProjectView(prev, id, project)
    })

    const project = id ? projectsRef.current.find(candidate => candidate.id === id) ?? null : null
    if (id) ensureRemoteConnected(id, project, connectSsh)
  }, [connectSsh, updateWindowViewState])

  const selectProjectHome = useCallback((projectId: string) => {
    const project = projectsRef.current.find(p => p.id === projectId) ?? null
    if (!project) return
    updateWindowViewState(prev => selectProjectHomeView(prev, projectId))
    ensureRemoteConnected(projectId, project, connectSsh)
  }, [connectSsh, updateWindowViewState])

  const selectTask = useCallback((id: string | null) => {
    updateWindowViewState(prev => ({ ...prev, selectedTaskId: id }))
  }, [updateWindowViewState])

  const switchToTask = useCallback((projectId: string, taskId: string) => {
    updateWindowViewState(prev => switchToTaskView(prev, projectId, taskId))

    markTaskVisited(projectId, taskId)

    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    ensureRemoteConnected(projectId, project, connectSsh)
  }, [connectSsh, updateWindowViewState, markTaskVisited])

  return {
    setSelectedProjectId: selectProject,
    selectProjectHome,
    setSelectedTaskId: selectTask,
    switchToTask
  }
}

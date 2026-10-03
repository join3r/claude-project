import { useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { isEphemeralProject, isHomeTask } from '../../../shared/types'
import type { Tab, Task, WorkspaceConfig, WorkspaceDraft } from '../../../shared/types'
import type { AppStateCore } from './useAppStateCore'
import {
  addTaskInDirectoryData,
  appendTaskToProject,
  getProjectDir,
  makeTask,
  mapProject,
  mapTask,
  removeTaskFromData,
  reorderList,
  tabIdsOfTask
} from './projectsData'
import { removeTaskView, selectNewTaskView } from './viewState'
import { reportRefusedWorkspaceDelete } from './useProjects'

export interface TasksActions {
  addTask: (projectId: string, name: string, initialTabs?: Tab[]) => Task
  addWorkspaceTask: (projectId: string, name: string, workspace: WorkspaceConfig, initialTabs?: Tab[]) => Task
  addTaskInDirectory: (directory: string, name: string, initialTabs?: Tab[], workspace?: WorkspaceConfig, workspaceDraft?: WorkspaceDraft) => Task
  /** An empty task that becomes a workspace once its first tab opens (see `Task.workspaceDraft`). */
  addPendingWorkspaceTask: (projectId: string, name: string, draft?: WorkspaceDraft) => Task
  /** Change a pending workspace task's draft; null turns it into a plain task. */
  setWorkspaceDraft: (projectId: string, taskId: string, draft: WorkspaceDraft | null) => void
  /** Point a task at the worktree just created for it, ending its draft. */
  attachWorkspace: (projectId: string, taskId: string, workspace: WorkspaceConfig) => void
  removeTask: (projectId: string, taskId: string, skipWorkspaceCleanup?: boolean) => Promise<void>
  renameTask: (projectId: string, taskId: string, name: string) => void
  reorderTasks: (projectId: string, fromIndex: number, toIndex: number) => void
}

/** Creating, removing, renaming and ordering tasks. */
export function useTasks(
  core: AppStateCore,
  deps: { confirmDiscardDirty: (tabIds: string[]) => Promise<'proceed' | 'cancel'> }
): TasksActions {
  const { mutateProjects, projectsRef, updateWindowViewState } = core
  const { confirmDiscardDirty } = deps

  // `initialTabs` exists so a task can be born with its tabs: calling `addTab` right
  // after this would read a `projectsRef` that hasn't seen the task yet and clobber
  // the view state written below.
  const addTask = useCallback((projectId: string, name: string, initialTabs: Tab[] = []) => {
    const task = makeTask(name, initialTabs)
    mutateProjects(prev => appendTaskToProject(prev, projectId, task))
    updateWindowViewState(prev => selectNewTaskView(prev, projectId, task))
    return task
  }, [mutateProjects, updateWindowViewState])

  const addWorkspaceTask = useCallback((
    projectId: string,
    name: string,
    workspace: WorkspaceConfig,
    initialTabs: Tab[] = []
  ) => {
    const task = makeTask(name, initialTabs, workspace)
    mutateProjects(prev => appendTaskToProject(prev, projectId, task))
    updateWindowViewState(prev => selectNewTaskView(prev, projectId, task))
    return task
  }, [mutateProjects, updateWindowViewState])

  /**
   * File a task against a bare directory. The hidden project that owns it is
   * created — or reused, keyed on the path — in the *same* mutation as the task,
   * so an empty ad-hoc project never reaches disk and the "prune the spent ones"
   * sweep in storage can stay unconditional.
   */
  const addTaskInDirectory = useCallback((
    directory: string,
    name: string,
    initialTabs: Tab[] = [],
    workspace?: WorkspaceConfig,
    workspaceDraft?: WorkspaceDraft
  ) => {
    const task: Task = { ...makeTask(name, initialTabs, workspace), ...(workspaceDraft ? { workspaceDraft } : {}) }
    // Resolved before the mutation, not inside it: the updater is replayed against
    // the synced snapshot as well as local state, so it has to be idempotent.
    const existing = projectsRef.current.find(p => isEphemeralProject(p) && p.directory === directory)
    const ownerId = existing?.id ?? uuid()
    mutateProjects(prev => addTaskInDirectoryData(prev, ownerId, directory, task))
    updateWindowViewState(prev => selectNewTaskView(prev, ownerId, task))
    return task
  }, [mutateProjects, updateWindowViewState])

  const removeTask = useCallback(async (projectId: string, taskId: string, skipWorkspaceCleanup?: boolean) => {
    const doomed = projectsRef.current
      .find(candidate => candidate.id === projectId)?.tasks
      .find(candidate => candidate.id === taskId)
    if (doomed && isHomeTask(doomed)) return
    // One dialog for every unsaved editor under the task, not one per tab.
    if (doomed && await confirmDiscardDirty(tabIdsOfTask(doomed)) === 'cancel') return

    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = project?.tasks.find(candidate => candidate.id === taskId)
    if (task && isHomeTask(task)) return
    if (task) {
      for (const tab of [...task.tabs.left, ...task.tabs.right]) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
        void window.api.scrollbackDelete(tab.id)
      }
      if (task.workspace && project && !skipWorkspaceCleanup) {
        void window.api.workspaceDelete(
          {
            projectDir: getProjectDir(project),
            projectId: project.ssh ? projectId : undefined,
            sshConfig: project.ssh,
            worktreePath: task.workspace.worktreePath,
            branchName: task.workspace.branchName,
            baseBranch: task.workspace.baseBranch,
            force: true
          }
        ).then(reportRefusedWorkspaceDelete).catch(() => {})
      }
    }

    // A hidden ad-hoc project exists only to give its tasks somewhere to live —
    // once the last real one is gone it goes with them, in the same mutation so
    // no empty record is ever written out.
    const ownerRetired = !!project
      && isEphemeralProject(project)
      && !project.tasks.some(candidate => candidate.id !== taskId && !isHomeTask(candidate))
    mutateProjects(prev => removeTaskFromData(prev, projectId, taskId))
    updateWindowViewState(prev => removeTaskView(prev, projectId, taskId, ownerRetired))
  }, [confirmDiscardDirty, mutateProjects, updateWindowViewState])

  const addPendingWorkspaceTask = useCallback((projectId: string, name: string, draft: WorkspaceDraft = {}) => {
    const task: Task = { ...makeTask(name, []), workspaceDraft: draft }
    mutateProjects(prev => appendTaskToProject(prev, projectId, task))
    updateWindowViewState(prev => selectNewTaskView(prev, projectId, task))
    return task
  }, [mutateProjects, updateWindowViewState])

  const setWorkspaceDraft = useCallback((projectId: string, taskId: string, draft: WorkspaceDraft | null) => {
    mutateProjects(prev => mapTask(prev, projectId, taskId, ({ workspaceDraft: _old, ...task }) => (
      draft ? { ...task, workspaceDraft: draft } : task
    )))
  }, [mutateProjects])

  const attachWorkspace = useCallback((projectId: string, taskId: string, workspace: WorkspaceConfig) => {
    mutateProjects(prev => mapTask(prev, projectId, taskId, ({ workspaceDraft: _draft, ...task }) => ({ ...task, workspace })))
  }, [mutateProjects])

  const renameTask = useCallback((projectId: string, taskId: string, name: string) => {
    mutateProjects(prev => mapTask(prev, projectId, taskId, task => ({ ...task, name })))
  }, [mutateProjects])

  const reorderTasks = useCallback((projectId: string, fromIndex: number, toIndex: number) => {
    mutateProjects(prev => mapProject(prev, projectId, project => ({
      ...project,
      tasks: reorderList(project.tasks, fromIndex, toIndex)
    })))
  }, [mutateProjects])

  return { addTask, addWorkspaceTask, addTaskInDirectory, addPendingWorkspaceTask, setWorkspaceDraft, attachWorkspace, removeTask, renameTask, reorderTasks }
}

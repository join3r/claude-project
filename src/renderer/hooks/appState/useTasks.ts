import { useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { isEphemeralProject } from '../../../shared/types'
import type { Tab, Task, WorkspaceConfig, WorkspaceDraft } from '../../../shared/types'
import type { AppStateCore } from './useAppStateCore'
import { findTaskInProject, projectTasks, runsInTaskDir, taskTabs, workspaceReleasedBy } from '../../../shared/streams'
import {
  addTaskInDirectoryData,
  appendTaskToProject,
  attachWorkspaceInData,
  getProjectDir,
  makeTask,
  mapTask,
  removeTaskFromData,
  moveTaskInData,
  removeStreamFromData,
  renameStreamInData,
  tabIdsOfTask
} from './projectsData'
import { removeTaskView, selectNewTaskView } from './viewState'
import { reportRefusedWorkspaceDelete } from './useProjects'
import { resolveLandingTaskId } from '../taskNavigation'

export interface TasksActions {
  addTask: (projectId: string, name: string, initialTabs?: Tab[]) => Task
  addWorkspaceTask: (projectId: string, name: string, workspace: WorkspaceConfig, initialTabs?: Tab[]) => Task
  addTaskInDirectory: (directory: string, name: string, initialTabs?: Tab[], workspace?: WorkspaceConfig, workspaceDraft?: WorkspaceDraft) => Task
  /** An empty task that becomes a workspace once its first tab opens (see `Task.workspaceDraft`). */
  addPendingWorkspaceTask: (projectId: string, name: string, draft?: WorkspaceDraft) => Task
  /** Change a pending workspace task's draft; null turns it into a plain task. */
  setWorkspaceDraft: (projectId: string, taskId: string, draft: WorkspaceDraft | null) => void
  /** Point a task's stream at the worktree just created for it, ending its draft. */
  attachWorkspace: (projectId: string, taskId: string, workspace: WorkspaceConfig) => void
  removeTask: (projectId: string, taskId: string, skipWorkspaceCleanup?: boolean) => Promise<void>
  renameTask: (projectId: string, taskId: string, name: string) => void
  /**
   * Move a task to `toIndex` of stream `toStreamId` (counted without the task).
   * `restart` is for a move into another directory: its agent and terminals stop
   * here and start again in the new one (asks first about unsaved editors).
   * Resolves false when that question was cancelled.
   */
  moveTask: (projectId: string, taskId: string, toStreamId: string, toIndex: number, options?: { restart?: boolean }) => Promise<boolean>
  /**
   * Remove a stream (never `main`) and every task in it. The worktree is removed
   * too unless `skipWorkspaceCleanup` (the caller already ran the pre-flight).
   * Resolves false when nothing was removed (unsaved editors kept it).
   */
  removeStream: (projectId: string, streamId: string, skipWorkspaceCleanup?: boolean) => Promise<boolean>
  renameStream: (projectId: string, streamId: string, name: string) => void
  /**
   * The task a tab opened with no task selected (the project's Home page) lands in:
   * `taskId` when it is one of the project's tasks, else the `main` stream's task
   * it was last on (`resolveLandingTaskId`), which the window switches to. An empty
   * `main` gets a new task named `name` and holding `makeTab()`; then the result is
   * null, since the tab is already open.
   */
  taskForTab: (projectId: string, taskId: string | null, makeTab: () => Tab, name: string) => string | null
}

/** Creating, removing, renaming and ordering tasks. */
export function useTasks(
  core: AppStateCore,
  deps: {
    confirmDiscardDirty: (tabIds: string[]) => Promise<'proceed' | 'cancel'>
    switchToTask: (projectId: string, taskId: string) => void
  }
): TasksActions {
  const { mutateProjects, projectsRef, updateWindowViewState } = core
  const { confirmDiscardDirty, switchToTask } = deps

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
    const task = makeTask(name, initialTabs)
    const placement = { workspace, streamId: uuid() }
    mutateProjects(prev => appendTaskToProject(prev, projectId, task, placement))
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
    const task: Task = makeTask(name, initialTabs, workspaceDraft)
    // Resolved before the mutation, not inside it: the updater is replayed against
    // the synced snapshot as well as local state, so it has to be idempotent.
    const existing = projectsRef.current.find(p => isEphemeralProject(p) && p.directory === directory)
    const ownerId = existing?.id ?? uuid()
    const placement = { workspace, ownStream: !!workspaceDraft, streamId: uuid() }
    mutateProjects(prev => addTaskInDirectoryData(prev, ownerId, directory, task, placement))
    updateWindowViewState(prev => selectNewTaskView(prev, ownerId, task))
    return task
  }, [mutateProjects, updateWindowViewState])

  const removeTask = useCallback(async (projectId: string, taskId: string, skipWorkspaceCleanup?: boolean) => {
    const doomed = findTaskInProject(projectsRef.current.find(candidate => candidate.id === projectId), taskId)
    // One dialog for every unsaved editor under the task, not one per tab.
    if (doomed && await confirmDiscardDirty(tabIdsOfTask(doomed)) === 'cancel') return

    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = findTaskInProject(project, taskId)
    if (task) {
      for (const tab of taskTabs(task)) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
        void window.api.scrollbackDelete(tab.id)
      }
      // The worktree goes only with its stream's last task.
      const workspace = workspaceReleasedBy(project, taskId)
      if (workspace && project && !skipWorkspaceCleanup) {
        void window.api.workspaceDelete(
          {
            projectDir: getProjectDir(project),
            projectId: project.ssh ? projectId : undefined,
            sshConfig: project.ssh,
            worktreePath: workspace.worktreePath,
            branchName: workspace.branchName,
            baseBranch: workspace.baseBranch,
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
      && !projectTasks(project).some(candidate => candidate.id !== taskId)
    mutateProjects(prev => removeTaskFromData(prev, projectId, taskId))
    updateWindowViewState(prev => removeTaskView(prev, projectId, taskId, ownerRetired))
  }, [confirmDiscardDirty, mutateProjects, updateWindowViewState])

  const addPendingWorkspaceTask = useCallback((projectId: string, name: string, draft: WorkspaceDraft = {}) => {
    const task: Task = makeTask(name, [], draft)
    const placement = { ownStream: true, streamId: uuid() }
    mutateProjects(prev => appendTaskToProject(prev, projectId, task, placement))
    updateWindowViewState(prev => selectNewTaskView(prev, projectId, task))
    return task
  }, [mutateProjects, updateWindowViewState])

  const setWorkspaceDraft = useCallback((projectId: string, taskId: string, draft: WorkspaceDraft | null) => {
    mutateProjects(prev => mapTask(prev, projectId, taskId, ({ workspaceDraft: _old, ...task }) => (
      draft ? { ...task, workspaceDraft: draft } : task
    )))
  }, [mutateProjects])

  const attachWorkspace = useCallback((projectId: string, taskId: string, workspace: WorkspaceConfig) => {
    const streamId = uuid()
    mutateProjects(prev => attachWorkspaceInData(prev, projectId, taskId, workspace, streamId))
  }, [mutateProjects])

  const renameTask = useCallback((projectId: string, taskId: string, name: string) => {
    mutateProjects(prev => mapTask(prev, projectId, taskId, task => ({ ...task, name })))
  }, [mutateProjects])

  const moveTask = useCallback(async (
    projectId: string,
    taskId: string,
    toStreamId: string,
    toIndex: number,
    options: { restart?: boolean } = {}
  ) => {
    const task = findTaskInProject(projectsRef.current.find(candidate => candidate.id === projectId), taskId)
    if (!task) return false
    if (options.restart) {
      if (await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return false
      // Ending the session here is the restart: the tab bodies are keyed on the
      // task's directory (TaskPanes), so they mount again and spawn in the new one.
      for (const tab of taskTabs(task).filter(runsInTaskDir)) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
      }
    }
    mutateProjects(prev => moveTaskInData(prev, projectId, taskId, toStreamId, toIndex))
    return true
  }, [confirmDiscardDirty, mutateProjects])

  const removeStream = useCallback(async (projectId: string, streamId: string, skipWorkspaceCleanup?: boolean) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const stream = project?.streams.find(candidate => candidate.id === streamId)
    if (!project || !stream || stream.isMain) return false
    const tabIds = stream.tasks.flatMap(tabIdsOfTask)
    if (await confirmDiscardDirty(tabIds) === 'cancel') return false
    for (const tabId of tabIds) {
      window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
      void window.api.scrollbackDelete(tabId)
    }
    const workspace = stream.workspace
    if (workspace && !skipWorkspaceCleanup) {
      void window.api.workspaceDelete(
        {
          projectDir: getProjectDir(project),
          projectId: project.ssh ? projectId : undefined,
          sshConfig: project.ssh,
          worktreePath: workspace.worktreePath,
          branchName: workspace.branchName,
          baseBranch: workspace.baseBranch,
          force: true
        }
      ).then(reportRefusedWorkspaceDelete).catch(() => {})
    }
    const ownerRetired = isEphemeralProject(project)
      && !project.streams.some(candidate => candidate.id !== streamId && candidate.tasks.length > 0)
    mutateProjects(prev => removeStreamFromData(prev, projectId, streamId))
    updateWindowViewState(prev => stream.tasks.reduce(
      (view, task) => removeTaskView(view, projectId, task.id, ownerRetired),
      prev
    ))
    return true
  }, [confirmDiscardDirty, mutateProjects, updateWindowViewState])

  const renameStream = useCallback((projectId: string, streamId: string, name: string) => {
    mutateProjects(prev => renameStreamInData(prev, projectId, streamId, name))
  }, [mutateProjects])

  const taskForTab = useCallback((projectId: string, taskId: string | null, makeTab: () => Tab, name: string) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    if (!project) return null
    if (taskId && findTaskInProject(project, taskId)) return taskId
    const landing = resolveLandingTaskId(project)
    if (landing) {
      switchToTask(projectId, landing)
      return landing
    }
    addTask(projectId, name, [makeTab()])
    return null
  }, [addTask, switchToTask])

  return { addTask, addWorkspaceTask, addTaskInDirectory, addPendingWorkspaceTask, setWorkspaceDraft, attachWorkspace, removeTask, renameTask, moveTask, removeStream, renameStream, taskForTab }
}

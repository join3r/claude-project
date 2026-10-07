import { useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { isEphemeralProject } from '../../../shared/types'
import type { Stream, Tab, Task, WorkspaceConfig } from '../../../shared/types'
import type { AppStateCore } from './useAppStateCore'
import { findStreamOfTask, findTaskInProject, planTaskMove, projectTasks, streamDirectory, taskTabs } from '../../../shared/streams'
import { patchTabInTask } from '../../../shared/panes'
import {
  addStreamInData,
  addTaskInDirectoryData,
  appendTaskToProject,
  getProjectDir,
  makeStream,
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
  /** A task in stream `streamId` (`main` when absent), selected in this window. */
  addTask: (projectId: string, name: string, initialTabs?: Tab[], streamId?: string | null) => Task
  addTaskInDirectory: (directory: string, name: string, initialTabs?: Tab[]) => Task
  /** A new stream at the end of the project's list: a worktree's, or the project folder's. */
  addStream: (projectId: string, name: string, workspace?: WorkspaceConfig) => Stream
  /**
   * Close a task: its tabs end and it leaves its stream (which stays, even
   * emptied). Asks first only about unsaved editors; the caller asks the rest.
   * Resolves false when that question was cancelled.
   */
  removeTask: (projectId: string, taskId: string) => Promise<boolean>
  renameTask: (projectId: string, taskId: string, name: string) => void
  /**
   * Move a task to `toIndex` of stream `toStreamId` (counted without the task).
   * `restart` is for a move into another directory: its sessions are copied
   * there, its agents and terminals stop (in every window) and start again in
   * the new one (asks first about unsaved editors). Resolves false when that
   * question was cancelled.
   */
  moveTask: (projectId: string, taskId: string, toStreamId: string, toIndex: number, options?: { restart?: boolean }) => Promise<boolean>
  /**
   * Remove a stream (never `main`) and every task in it. The worktree is removed
   * too unless `skipWorkspaceCleanup` (the caller already ran the pre-flight).
   * Resolves false when nothing was removed (unsaved editors kept it).
   */
  removeStream: (projectId: string, streamId: string, skipWorkspaceCleanup?: boolean) => Promise<boolean>
  /** Rename a stream. Its branch keeps its name. */
  renameStream: (projectId: string, streamId: string, name: string) => void
  /**
   * The task a tab opened with no task selected (the project's Home page) lands in:
   * `taskId` when it is one of the project's tasks, else the `main` stream's task
   * it was last on (`resolveLandingTaskId`), which the window switches to. An empty
   * `main` gets a new task named `name` and holding `makeTab()`; then the result is
   * null, since the tab is already open. Deliberately `main` and not the stream
   * last worked in: Home and its file browser show the project folder, and `main`
   * is the stream that works there (a file path opened in a worktree task would
   * resolve against the worktree).
   */
  taskForTab: (projectId: string, taskId: string | null, makeTab: () => Tab, name: string) => string | null
}

/** Creating, closing, renaming and moving tasks and streams. */
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
  const addTask = useCallback((projectId: string, name: string, initialTabs: Tab[] = [], streamId?: string | null) => {
    const task = makeTask(name, initialTabs)
    mutateProjects(prev => appendTaskToProject(prev, projectId, task, streamId))
    updateWindowViewState(prev => selectNewTaskView(prev, projectId, task))
    return task
  }, [mutateProjects, updateWindowViewState])

  /**
   * File a task against a bare directory. The hidden project that owns it is
   * created — or reused, keyed on the path — in the *same* mutation as the task,
   * so an empty ad-hoc project never reaches disk and the "prune the spent ones"
   * sweep in storage can stay unconditional.
   */
  const addTaskInDirectory = useCallback((directory: string, name: string, initialTabs: Tab[] = []) => {
    const task: Task = makeTask(name, initialTabs)
    // Resolved before the mutation, not inside it: the updater is replayed against
    // the synced snapshot as well as local state, so it has to be idempotent.
    const existing = projectsRef.current.find(p => isEphemeralProject(p) && p.directory === directory)
    const ownerId = existing?.id ?? uuid()
    mutateProjects(prev => addTaskInDirectoryData(prev, ownerId, directory, task))
    updateWindowViewState(prev => selectNewTaskView(prev, ownerId, task))
    return task
  }, [mutateProjects, updateWindowViewState])

  const addStream = useCallback((projectId: string, name: string, workspace?: WorkspaceConfig) => {
    const stream = makeStream(name, workspace)
    mutateProjects(prev => addStreamInData(prev, projectId, stream))
    return stream
  }, [mutateProjects])

  const removeTask = useCallback(async (projectId: string, taskId: string) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = findTaskInProject(project, taskId)
    if (!project || !task) return false
    // One dialog for every unsaved editor under the task, not one per tab.
    if (await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return false

    for (const tab of taskTabs(task)) {
      window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
      void window.api.scrollbackDelete(tab.id)
    }

    // A hidden ad-hoc project exists only to give its tasks somewhere to live —
    // once the last real one is gone it goes with them, in the same mutation so
    // no empty record is ever written out.
    const ownerRetired = isEphemeralProject(project)
      && !projectTasks(project).some(candidate => candidate.id !== taskId)
    mutateProjects(prev => removeTaskFromData(prev, projectId, taskId))
    updateWindowViewState(prev => removeTaskView(prev, projectId, taskId, ownerRetired))
    return true
  }, [confirmDiscardDirty, mutateProjects, updateWindowViewState])

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
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = findTaskInProject(project, taskId)
    const to = project?.streams.find(stream => stream.id === toStreamId)
    if (!project || !task || !to) return false
    let cwds: { tabId: string; cwd: string | undefined }[] = []
    if (options.restart) {
      if (await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return false
      const fromDir = streamDirectory(project, findStreamOfTask(project, taskId))
      const toDir = streamDirectory(project, to)
      const plan = planTaskMove(task, fromDir, toDir)
      // Claude and Pi keep sessions per directory: copy them over first, so the
      // restart there resumes the conversation instead of starting a new one.
      let dirsExist: boolean[] = []
      try {
        const prepared = await window.api.taskMovePrepare(
          fromDir,
          toDir,
          plan.sessions,
          plan.cwdMoves.map(move => move.cwd),
          project.ssh ? projectId : undefined,
          project.ssh
        )
        dirsExist = prepared.dirsExist
      } catch {
        // The agents start new sessions, as before; terminals start in the task's folder.
      }
      // A terminal on a sub-folder follows it into the new worktree, or starts at
      // the new worktree's top when that folder isn't there.
      cwds = plan.cwdMoves.map((move, i) => ({ tabId: move.tabId, cwd: dirsExist[i] ? move.cwd : undefined }))
      // Ending the sessions here is the restart: the tab bodies are keyed on the
      // directory they run in (TaskPanes), so they mount again and spawn there.
      // Main ends the processes and tells the other windows to drop their copies.
      for (const tabId of plan.restartTabIds) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
      }
      if (plan.restartTabIds.length > 0) await window.api.restartTabs(plan.restartTabIds).catch(() => {})
    }
    mutateProjects(prev => {
      const moved = moveTaskInData(prev, projectId, taskId, toStreamId, toIndex)
      if (cwds.length === 0) return moved
      return mapTask(moved, projectId, taskId, candidate => cwds.reduce(
        (next, { tabId, cwd }) => patchTabInTask(next, tabId, { cwd }),
        candidate
      ))
    })
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

  return { addTask, addTaskInDirectory, addStream, removeTask, renameTask, moveTask, removeStream, renameStream, taskForTab }
}

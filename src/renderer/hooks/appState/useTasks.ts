import { useCallback, useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import { isEphemeralProject } from '../../../shared/types'
import type { PendingWorktreeSetup, Project, ProjectsData, Stream, Tab, Task, WorkspaceConfig } from '../../../shared/types'
import type { AppStateCore } from './useAppStateCore'
import {
  findStreamOfTask,
  findTaskInProject,
  needsTaskWorktree,
  planTaskMove,
  projectTasks,
  reopenedTask,
  reopensInOwnWorktree,
  streamDirectory,
  taskDirectory,
  taskMoveBlocker,
  taskTabIds,
  taskTabs,
  waitsForTaskWorktree
} from '../../../shared/streams'
import { joinWorkspaceDir } from '../../../shared/workspace-path'
import { ensureTaskWorktree, holdTaskSpawn } from '../../taskWorktrees'
import {
  archiveStreamInData,
  archiveTasksInData,
  archivedStreamEntry,
  archivedTaskEntry,
  reopenStreamInData,
  reopenTargetStream,
  reopenTaskInData,
  syncArchiveCounts,
  visibleArchive,
  type ProjectArchive
} from '../../../shared/archive'
import { adoptArchive, loadArchive, setArchiveLoadedHandler } from '../archiveStore'
import { patchTabInTask } from '../../../shared/panes'
import {
  addStreamInData,
  addTaskInDirectoryData,
  appendTaskToProject,
  getProjectDir,
  makeStream,
  makeTask,
  mapTask,
  moveTaskInData,
  renameStreamInData,
  tabIdsOfTask
} from './projectsData'
import { removeTaskView, selectNewTaskView } from './viewState'
import { reportRefusedWorkspaceDelete } from './useProjects'
import { resolveLandingTaskId } from '../taskNavigation'

/** A reopened stream's worktree came back, but its setup failed or waits for approval. */
export interface ReopenedStreamSetup {
  branch: string
  error?: string
  pending?: PendingWorktreeSetup
}

export interface TasksActions {
  /** A task in stream `streamId` (`main` when absent), selected in this window. */
  addTask: (projectId: string, name: string, initialTabs?: Tab[], streamId?: string | null) => Task
  addTaskInDirectory: (directory: string, name: string, initialTabs?: Tab[]) => Task
  /** A new stream at the end of the project's list: a worktree's, or the project folder's. */
  addStream: (projectId: string, name: string, workspace?: WorkspaceConfig) => Stream
  /**
   * Close a task: it is archived. Its tabs end (their scrollback is kept for
   * Reopen) and it leaves its stream (which stays, even emptied) for that
   * stream's `Done (N)`. Asks first only about unsaved editors; the caller asks
   * the rest. Resolves false when that question was cancelled, or the archive
   * could not be written (nothing is closed then).
   */
  /** `dirtyChecked`: the caller already asked about unsaved editors (a landing saves them first). */
  archiveTask: (projectId: string, taskId: string, options?: { dirtyChecked?: boolean }) => Promise<boolean>
  renameTask: (projectId: string, taskId: string, name: string) => void
  /**
   * Move a task to `toIndex` of stream `toStreamId` (counted without the task).
   * `restart` is for a move into another directory: its sessions are copied
   * there, its agents and terminals stop (in every window) and start again in
   * the new one (asks first about unsaved editors). Into a worktree stream
   * where the task gets a worktree of its own, that worktree is made first and
   * the sessions go there. Resolves false when that question was cancelled, or
   * the task may not leave its stream (`taskMoveBlocker`).
   */
  moveTask: (projectId: string, taskId: string, toStreamId: string, toIndex: number, options?: { restart?: boolean }) => Promise<boolean>
  /**
   * Close a stream (never `main`): it is archived with every task in it, to the
   * project's `Done` group. The worktree is removed too unless
   * `skipWorkspaceCleanup` (the caller already ran the pre-flight). Resolves
   * false when nothing was closed (unsaved editors kept it, or the archive could
   * not be written). `dirtyChecked`: the caller already asked about unsaved editors.
   */
  archiveStream: (projectId: string, streamId: string, skipWorkspaceCleanup?: boolean, options?: { dirtyChecked?: boolean }) => Promise<boolean>
  /**
   * Reopen an archived task: back at the end of its stream (`main` when that
   * stream is closed), selected in this window. Its agent resumes its session
   * when its tabs mount; a session from another directory is copied over first.
   * In a task-worktree stream (`reopensInOwnWorktree`) its tabs wait for its own
   * worktree: back from the branch it kept, else a fresh one off the stream's
   * tip, with its sessions carried there. Elsewhere a kept branch stays in the
   * repository unused.
   */
  reopenTask: (projectId: string, taskId: string) => Promise<boolean>
  /**
   * Reopen an archived stream with the tasks it had open. A worktree stream gets
   * its worktree back from its branch (with the repo's setup; `setup` says when
   * that failed or its commands wait for approval); when the branch was
   * discarded it comes back as a project-folder stream and `notice` says so.
   * Rejects when git fails otherwise (nothing reopened). Its tasks with
   * worktrees of their own get them back as {@link reopenTask} says.
   */
  reopenStream: (projectId: string, streamId: string) => Promise<{ reopened: boolean; notice?: string; setup?: ReopenedStreamSetup }>
  /** Delete archived tasks and streams for good (and their tabs' scrollback). */
  deleteArchived: (projectId: string, ids: { tasks?: string[]; streams?: string[] }) => Promise<void>
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

  const archiveTask = useCallback(async (projectId: string, taskId: string, options: { dirtyChecked?: boolean } = {}) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = findTaskInProject(project, taskId)
    if (!project || !task) return false
    // One dialog for every unsaved editor under the task, not one per tab.
    if (!options.dirtyChecked && await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return false

    // A hidden ad-hoc project exists only to give its tasks somewhere to live —
    // once the last open one is gone it goes with them, in the same mutation so
    // no empty record is ever written out, and so does its archive.
    const ownerRetired = isEphemeralProject(project)
      && !projectTasks(project).some(candidate => candidate.id !== taskId)
    const entry = archivedTaskEntry(project, taskId, Date.now())
    // The file first, then the data: a crash in between leaves the task in both
    // (the Done row hides it while it is open), never in neither.
    if (entry && !ownerRetired && !await writeArchive(projectId, () => window.api.archiveAddTasks(projectId, [entry]))) return false

    // Ending the tabs; the scrollback stays for Reopen.
    for (const tab of taskTabs(task)) {
      window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId: tab.id } }))
    }
    mutateProjects(prev => archiveTasksInData(prev, projectId, [taskId]))
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
    const from = findStreamOfTask(project, taskId)
    const to = project?.streams.find(stream => stream.id === toStreamId)
    if (!project || !task || !from || !to || taskMoveBlocker(task, from, to)) return false
    const fromDir = taskDirectory(project, task)
    // Carry the sessions over, then patch terminals that follow a sub-folder.
    const carry = async (toDir: string): Promise<{ tabId: string; cwd: string | undefined }[]> => {
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
          projectId,
          project.ssh
        )
        dirsExist = prepared.dirsExist
      } catch {
        // The agents start new sessions, as before; terminals start in the task's folder.
      }
      // A terminal on a sub-folder follows it into the new worktree, or starts at
      // the new worktree's top when that folder isn't there.
      return plan.cwdMoves.map((move, i) => ({ tabId: move.tabId, cwd: dirsExist[i] ? move.cwd : undefined }))
    }
    const withCwds = (cwds: { tabId: string; cwd: string | undefined }[]) => (data: ProjectsData): ProjectsData => (
      cwds.length === 0 ? data : mapTask(data, projectId, taskId, candidate => cwds.reduce(
        (next, { tabId, cwd }) => patchTabInTask(next, tabId, { cwd }),
        candidate
      ))
    )
    // Ending the sessions here is the restart: the tab bodies are keyed on the
    // directory they run in (TaskPanes), so they mount again and spawn there.
    // Main ends the processes and tells the other windows to drop their copies.
    const endSessions = async (): Promise<void> => {
      // Which tabs restart doesn't depend on where they go.
      const restartTabIds = planTaskMove(task, fromDir, fromDir).restartTabIds
      for (const tabId of restartTabIds) {
        window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
      }
      if (restartTabIds.length > 0) await window.api.restartTabs(restartTabIds).catch(() => {})
    }

    if (options.restart && from.id !== to.id && needsTaskWorktree(project, to, task)) {
      if (await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return false
      // Its worktree doesn't exist yet: move, have it made, carry the sessions
      // there, and only then let the tabs start.
      const release = holdTaskSpawn(taskId)
      try {
        await endSessions()
        mutateProjects(prev => moveTaskInData(prev, projectId, taskId, toStreamId, toIndex))
        const made = await ensureTaskWorktree(projectId, taskId, { name: task.name, streamId: toStreamId })
        if (made.status === 'ready' || made.status === 'needs-approval') {
          const cwds = await carry(joinWorkspaceDir(made.workspace.worktreePath, made.workspace.relativeProjectPath))
          if (cwds.length > 0) mutateProjects(withCwds(cwds))
        }
      } finally {
        release()
      }
      return true
    }

    let cwds: { tabId: string; cwd: string | undefined }[] = []
    if (options.restart) {
      if (await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return false
      cwds = await carry(streamDirectory(project, to))
      await endSessions()
    }
    mutateProjects(prev => withCwds(cwds)(moveTaskInData(prev, projectId, taskId, toStreamId, toIndex)))
    return true
  }, [confirmDiscardDirty, mutateProjects])

  const archiveStream = useCallback(async (
    projectId: string,
    streamId: string,
    skipWorkspaceCleanup?: boolean,
    options: { dirtyChecked?: boolean } = {}
  ) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const stream = project?.streams.find(candidate => candidate.id === streamId)
    if (!project || !stream || stream.isMain) return false
    const tabIds = stream.tasks.flatMap(tabIdsOfTask)
    if (!options.dirtyChecked && await confirmDiscardDirty(tabIds) === 'cancel') return false
    const ownerRetired = isEphemeralProject(project)
      && !project.streams.some(candidate => candidate.id !== streamId && candidate.tasks.length > 0)
    const entry = archivedStreamEntry(project, streamId, Date.now())
    if (entry && !ownerRetired && !await writeArchive(projectId, () => window.api.archiveAddStream(projectId, entry))) return false
    for (const tabId of tabIds) {
      window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
    }
    const workspace = stream.workspace
    if (workspace && !skipWorkspaceCleanup) {
      void window.api.workspaceDelete(
        {
          projectDir: getProjectDir(project),
          projectId,
          sshConfig: project.ssh,
          worktreePath: workspace.worktreePath,
          branchName: workspace.branchName,
          baseBranch: workspace.baseBranch,
          force: true
        }
      ).then(reportRefusedWorkspaceDelete).catch(() => {})
    }
    mutateProjects(prev => archiveStreamInData(prev, projectId, streamId))
    updateWindowViewState(prev => stream.tasks.reduce(
      (view, task) => removeTaskView(view, projectId, task.id, ownerRetired),
      prev
    ))
    return true
  }, [confirmDiscardDirty, mutateProjects, updateWindowViewState])

  // Whenever this window reads an archive, the Done counts follow the file.
  useEffect(() => {
    setArchiveLoadedHandler((projectId, archive) => {
      mutateProjects(prev => syncArchiveCounts(prev, projectId, archive))
    })
    return () => setArchiveLoadedHandler(null)
  }, [mutateProjects])

  /**
   * A reopened task that works in a worktree of its own gets it before its tabs
   * spawn: restored from the branch it recorded, or fresh off the stream's tip
   * (step 3's `ensureTaskWorktree`). Then its sessions are carried there from
   * where they ran (`fromDir`). A task with nothing to spawn and nothing to
   * restore is left to get its worktree when it first needs one.
   */
  const settleOwnWorktree = useCallback(async (project: Project, streamId: string, task: Task, fromDir: string, release: () => void) => {
    try {
      if (!task.workspace && !taskTabs(task).some(waitsForTaskWorktree)) return
      const made = await ensureTaskWorktree(project.id, task.id, { name: task.name, streamId })
      if (made.status !== 'ready' && made.status !== 'needs-approval') return
      const cwds = await carrySessions(project, [task], fromDir, joinWorkspaceDir(made.workspace.worktreePath, made.workspace.relativeProjectPath))
      if (cwds.size > 0) mutateProjects(prev => mapTask(prev, project.id, task.id, current => withCwds(current, cwds)))
    } finally {
      release()
    }
  }, [mutateProjects])

  const reopenTask = useCallback(async (projectId: string, taskId: string) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    if (!project) return false
    const archive = visibleArchive(await loadArchive(projectId), project)
    const entry = archive.tasks.find(candidate => candidate.task.id === taskId)
    const target = entry && reopenTargetStream(project, entry)
    if (!entry || !target) return false
    const own = reopensInOwnWorktree(project, target, entry.task)
    let task = reopenedTask(entry.task, own)
    // Its tabs wait until its own worktree is there and its sessions are in it.
    const release = own ? holdTaskSpawn(taskId) : null
    if (!own) task = withCwds(task, await carrySessions(project, [task], entry.dir, streamDirectory(project, target)))
    // The data first, then the file (see `archiveTask`).
    mutateProjects(prev => reopenTaskInData(prev, projectId, { ...entry, task }))
    await writeArchive(projectId, () => window.api.archiveRemove(projectId, { tasks: [taskId] }))
    switchToTask(projectId, taskId)
    if (release) await settleOwnWorktree(project, target.id, task, entry.dir, release)
    return true
  }, [mutateProjects, projectsRef, switchToTask, settleOwnWorktree])

  const reopenStream = useCallback(async (projectId: string, streamId: string) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    if (!project) return { reopened: false }
    const archive = visibleArchive(await loadArchive(projectId), project)
    const entry = archive.streams.find(candidate => candidate.stream.id === streamId)
    if (!entry) return { reopened: false }
    let workspace: WorkspaceConfig | null = null
    let notice: string | undefined
    let setup: ReopenedStreamSetup | undefined
    const old = entry.stream.workspace
    if (old) {
      const restored = await window.api.workspaceRestore({
        projectDir: getProjectDir(project),
        projectId,
        sshConfig: project.ssh,
        worktreePath: old.worktreePath,
        branchName: old.branchName
      })
      if (restored.status === 'ok') {
        workspace = {
          worktreePath: restored.worktreePath,
          branchName: restored.branchName,
          baseBranch: old.baseBranch,
          relativeProjectPath: restored.relativeProjectPath
        }
        if (restored.setupError || restored.setupPending) {
          setup = { branch: restored.branchName, error: restored.setupError, pending: restored.setupPending }
        }
      } else {
        notice = `Branch "${old.branchName}" no longer exists, so "${entry.stream.name}" reopened in the project folder.`
      }
    }
    const reopened: Stream = { ...entry.stream, ...(workspace ? { workspace } : { workspace: undefined }) }
    const dir = streamDirectory(project, reopened)
    // Each task's sessions ran in its own worktree when it had one, else in the stream's directory.
    const plans = entry.stream.tasks.map(task => {
      const own = reopensInOwnWorktree(project, reopened, task)
      const fromDir = task.workspace ? joinWorkspaceDir(task.workspace.worktreePath, task.workspace.relativeProjectPath) : entry.dir
      return { task: reopenedTask(task, own), own, fromDir }
    })
    const tasks: Task[] = []
    for (const plan of plans) {
      tasks.push(plan.own ? plan.task : withCwds(plan.task, await carrySessions(project, [plan.task], plan.fromDir, dir)))
    }
    const releases = new Map(plans.filter(plan => plan.own).map(plan => [plan.task.id, holdTaskSpawn(plan.task.id)]))
    try {
      mutateProjects(prev => reopenStreamInData(prev, projectId, { ...entry, stream: { ...entry.stream, tasks } }, workspace))
      await writeArchive(projectId, () => window.api.archiveRemove(projectId, { streams: [streamId] }))
      const first = entry.stream.lastTaskId ?? entry.stream.tasks[0]?.id
      if (first) switchToTask(projectId, first)
      // One at a time: each is a `git worktree add` in the same repository.
      for (const plan of plans) {
        const release = releases.get(plan.task.id)
        if (release) await settleOwnWorktree(project, streamId, plan.task, plan.fromDir, release)
      }
    } finally {
      releases.forEach(release => release())
    }
    return { reopened: true, notice, setup }
  }, [mutateProjects, projectsRef, switchToTask, settleOwnWorktree])

  const deleteArchived = useCallback(async (projectId: string, ids: { tasks?: string[]; streams?: string[] }) => {
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    if (!project) return
    const archive = await loadArchive(projectId)
    const tasks = new Set(ids.tasks ?? [])
    const streams = new Set(ids.streams ?? [])
    const tabIds = [
      ...archive.tasks.filter(entry => tasks.has(entry.task.id)).flatMap(entry => taskTabIds(entry.task)),
      ...archive.streams.filter(entry => streams.has(entry.stream.id)).flatMap(entry => [
        ...entry.stream.tasks.flatMap(taskTabIds),
        ...entry.doneTasks.flatMap(done => taskTabIds(done.task))
      ])
    ]
    const next = await window.api.archiveRemove(projectId, ids)
    adoptArchive(projectId, next)
    mutateProjects(prev => syncArchiveCounts(prev, projectId, next))
    if (tabIds.length > 0) await window.api.archiveDeleteTabs(tabIds).catch(() => {})
  }, [mutateProjects, projectsRef])

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

  return {
    addTask, addTaskInDirectory, addStream, archiveTask, renameTask, moveTask, archiveStream, renameStream, taskForTab,
    reopenTask, reopenStream, deleteArchived
  }
}

/**
 * Write the archive file through `write` and adopt what it hands back. A failed
 * write says so and resolves false: whatever was being closed stays open.
 */
async function writeArchive(projectId: string, write: () => Promise<ProjectArchive>): Promise<boolean> {
  try {
    adoptArchive(projectId, await write())
    return true
  } catch (err) {
    window.alert(`Couldn't update the archive: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * A task reopening somewhere else than it was archived from (its stream is gone,
 * or its worktree came back elsewhere, fresh or not at all) takes its sessions
 * along: Claude and Pi keep them per directory, so they are copied over first
 * and its agent resumes there. A terminal opened on a folder inside the old
 * directory opens on the same folder in the new one, or at the new top when it
 * isn't there. Returns the new `cwd` per tab that has one to change.
 */
async function carrySessions(project: Project, tasks: Task[], fromDir: string, toDir: string): Promise<Map<string, string | undefined>> {
  if (!fromDir || fromDir === toDir) return new Map()
  const plans = tasks.map(task => planTaskMove(task, fromDir, toDir))
  const sessions = plans.flatMap(plan => plan.sessions)
  const cwdMoves = plans.flatMap(plan => plan.cwdMoves)
  if (sessions.length === 0 && cwdMoves.length === 0) return new Map()
  let dirsExist: boolean[] = []
  try {
    const prepared = await window.api.taskMovePrepare(
      fromDir, toDir, sessions, cwdMoves.map(move => move.cwd), project.id, project.ssh
    )
    dirsExist = prepared.dirsExist
  } catch {
    // The agents start new sessions instead; terminals start at the new top.
  }
  return new Map(cwdMoves.map((move, i) => [move.tabId, dirsExist[i] ? move.cwd : undefined]))
}

/** The task with these tabs' `cwd`s set (from {@link carrySessions}). */
function withCwds(task: Task, cwds: Map<string, string | undefined>): Task {
  if (!taskTabs(task).some(tab => cwds.has(tab.id))) return task
  return [...cwds].reduce((next, [tabId, cwd]) => patchTabInTask(next, tabId, { cwd }), task)
}

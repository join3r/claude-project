/**
 * Pure helpers over the Project › Stream › Task model: finding and mapping tasks
 * across a project's streams, and a task's tabs. Pane layout operations (split,
 * move, resize) live in `panes.ts`.
 */
import { isAgentTabType } from './types'
import type { Project, Stream, Tab, TabType, Task, TaskPane, WorkspaceConfig } from './types'
import { joinWorkspaceDir, retargetPath } from './workspace-path'

// --- Tasks across a project's streams ---------------------------------------

/** Every task of the project, stream by stream, in order. */
export function projectTasks(project: Project | undefined | null): Task[] {
  return (project?.streams ?? []).flatMap(stream => stream.tasks)
}

export function findTaskInProject(project: Project | undefined | null, taskId: string | null | undefined): Task | undefined {
  if (!project || !taskId) return undefined
  for (const stream of project.streams ?? []) {
    const task = stream.tasks.find(candidate => candidate.id === taskId)
    if (task) return task
  }
  return undefined
}

export function findStreamOfTask(project: Project | undefined | null, taskId: string | null | undefined): Stream | undefined {
  if (!project || !taskId) return undefined
  return (project.streams ?? []).find(stream => stream.tasks.some(task => task.id === taskId))
}

export function findMainStream(project: Project): Stream | undefined {
  return (project.streams ?? []).find(stream => stream.isMain)
}

/**
 * The worktree a task works in: its own, else its stream's (a task sharing the
 * stream's worktree, or one whose own is not made yet).
 */
export function taskWorkspace(project: Project | undefined | null, taskId: string | null | undefined): WorkspaceConfig | undefined {
  if (!project || !taskId) return undefined
  for (const stream of project.streams ?? []) {
    const task = stream.tasks.find(candidate => candidate.id === taskId)
    if (task) return task.workspace ?? stream.workspace
  }
  return undefined
}

/**
 * The directory a stream's tasks work in: its worktree (plus the project's place
 * inside the repository), else the project's own directory (the remote one over SSH).
 */
export function streamDirectory(project: Project, stream: Stream | undefined): string {
  if (stream?.workspace) return joinWorkspaceDir(stream.workspace.worktreePath, stream.workspace.relativeProjectPath)
  return project.ssh ? project.ssh.remoteDir : project.directory
}

/**
 * The directory a task's tabs run in: its own worktree (plus the project's place
 * inside the repository), else its stream's directory. A task not in `project`
 * (an archived one) gets the project's own directory.
 */
export function taskDirectory(project: Project, task: Task): string {
  if (task.workspace) return joinWorkspaceDir(task.workspace.worktreePath, task.workspace.relativeProjectPath)
  return streamDirectory(project, findStreamOfTask(project, task.id))
}

/**
 * Whether `task` is still to get a worktree of its own before its first tab
 * spawns: its stream is a migrated worktree stream (`taskWorktrees`), the project
 * is local (SSH projects keep sharing the stream's worktree), and the task has no
 * worktree yet and does not share the stream's.
 */
export function needsTaskWorktree(project: Project, stream: Stream, task: Task): boolean {
  return !!stream.workspace
    && !!stream.taskWorktrees
    && !project.ssh
    && !task.workspace
    && !task.sharesStreamWorktree
}

/** `fn` applied to every task; untouched streams and projects keep their identity. */
export function mapProjectTasks(project: Project, fn: (task: Task, stream: Stream) => Task): Project {
  let changed = false
  const streams = project.streams.map(stream => {
    let streamChanged = false
    const tasks = stream.tasks.map(task => {
      const next = fn(task, stream)
      if (next !== task) streamChanged = true
      return next
    })
    if (!streamChanged) return stream
    changed = true
    return { ...stream, tasks }
  })
  return changed ? { ...project, streams } : project
}

export function mapTaskInProject(project: Project, taskId: string, fn: (task: Task) => Task): Project {
  return mapProjectTasks(project, task => (task.id === taskId ? fn(task) : task))
}

/**
 * Drop a task. Its stream stays, even emptied: `main` can only be emptied, and
 * any other stream (with its worktree) lives until it is closed itself.
 */
export function removeTaskFromProject(project: Project, taskId: string): Project {
  const stream = findStreamOfTask(project, taskId)
  if (!stream) return project
  return {
    ...project,
    streams: project.streams.map(candidate => {
      if (candidate !== stream) return candidate
      const { lastTaskId, ...rest } = candidate
      const tasks = candidate.tasks.filter(task => task.id !== taskId)
      return lastTaskId === taskId ? { ...rest, tasks } : { ...candidate, tasks }
    })
  }
}

/**
 * The stream a new task in `project` goes to when none is named: the stream of
 * the task this window shows, else the one the project was last left in, else
 * `main`.
 */
export function currentStreamId(project: Project, selectedTaskId?: string | null): string | undefined {
  const selected = findStreamOfTask(project, selectedTaskId)
  if (selected) return selected.id
  const last = project.streams.find(stream => stream.id === project.lastStreamId)
  return (last ?? findMainStream(project) ?? project.streams[0])?.id
}

/** Append `task` to the stream `streamId`, or to `main` when that stream is gone. */
export function addTaskToStream(project: Project, streamId: string | null, task: Task): Project {
  const target = project.streams.find(stream => stream.id === streamId) ?? findMainStream(project)
  if (!target) return project
  return {
    ...project,
    streams: project.streams.map(stream => (stream === target ? { ...stream, tasks: [...stream.tasks, task] } : stream))
  }
}

/**
 * The stream the New stream dialog (and a phone's `stream.new`) creates: a worktree,
 * or the project folder when `workspace` is absent.
 */
export function makeStreamWithId(id: string, name: string, workspace?: WorkspaceConfig): Stream {
  return { id, name, ...(workspace ? { workspace, taskWorktrees: true as const } : {}), tasks: [] }
}

/** Add `stream` at the end of the project's list. One already there is left alone. */
export function addStreamToProject(project: Project, stream: Stream): Project {
  return project.streams.some(candidate => candidate.id === stream.id)
    ? project
    : { ...project, streams: [...project.streams, stream] }
}

/** Whether a stream may offer a worktree: not for a shell-command project. */
export function streamWorktreeSupported(project: Project): boolean {
  return !project.shellCommand
}

/** The task the project was last left on, when it still exists. */
export function projectLastTaskId(project: Project): string | undefined {
  const stream = project.streams.find(candidate => candidate.id === project.lastStreamId)
  const taskId = stream?.lastTaskId
  return taskId && stream.tasks.some(task => task.id === taskId) ? taskId : undefined
}

/** Remember `taskId` as where the project (and its stream) was last left. */
export function withLastTask(project: Project, taskId: string): Project {
  const stream = findStreamOfTask(project, taskId)
  if (!stream) return project
  if (project.lastStreamId === stream.id && stream.lastTaskId === taskId) return project
  return {
    ...project,
    lastStreamId: stream.id,
    streams: project.streams.map(candidate => (candidate === stream ? { ...candidate, lastTaskId: taskId } : candidate))
  }
}

// --- A task's tabs and panes -------------------------------------------------

/** Every tab of the task, pane by pane. */
export function taskTabs(task: Task): Tab[] {
  return task.panes.flatMap(pane => pane.tabs)
}

/** The task's main tab (its agent or terminal) closes only with the task. */
export function isMainTab(task: Task, tabId: string): boolean {
  return task.mainTabId === tabId
}

/**
 * Whether `type` may join `task`: a task has one agent (Claude chat or a terminal
 * agent), so an agent tab is refused when the task already holds one. A second
 * agent is a new task.
 */
export function canAddTabType(task: Task, type: TabType): boolean {
  return !isAgentTabType(type) || !taskTabs(task).some(tab => isAgentTabType(tab.type))
}

export function taskTabIds(task: Task): string[] {
  return taskTabs(task).map(tab => tab.id)
}

/**
 * The agent tab, else the terminal, that a task is about. Keeps `current` while
 * the task still holds it.
 */
export function resolveMainTabId(tabs: readonly Tab[], current?: string): string | undefined {
  if (current && tabs.some(tab => tab.id === current)) return current
  return (tabs.find(tab => isAgentTabType(tab.type)) ?? tabs.find(tab => tab.type === 'terminal'))?.id
}

/**
 * `fn` applied to each pane's tabs. Panes left empty close, the survivors share
 * the row in proportion, and active and main tabs follow. Returns `task` itself
 * when nothing changed.
 */
export function mapTaskTabs(task: Task, fn: (tabs: Tab[]) => Tab[]): Task {
  let changed = false
  const panes: TaskPane[] = []
  for (const pane of task.panes) {
    const tabs = fn(pane.tabs)
    if (tabs !== pane.tabs) changed = true
    if (tabs.length === 0) continue
    const activeTabId = tabs.some(tab => tab.id === pane.activeTabId) ? pane.activeTabId : tabs[tabs.length - 1].id
    panes.push(tabs === pane.tabs ? pane : { ...pane, tabs, activeTabId })
  }
  if (!changed) return task
  const total = panes.reduce((sum, pane) => sum + pane.width, 0)
  const next: Task = {
    ...task,
    panes: panes.map(pane => ({ ...pane, width: total > 0 ? pane.width / total : 1 / panes.length }))
  }
  const mainTabId = resolveMainTabId(next.panes.flatMap(pane => pane.tabs), task.mainTabId)
  if (mainTabId) next.mainTabId = mainTabId
  else delete next.mainTabId
  return next
}

/**
 * A tab whose session runs in the task's directory, so it starts again when the
 * task moves to another worktree: agents and terminals, except a terminal opened
 * on a folder of its own.
 */
export function runsInTaskDir(tab: Tab): boolean {
  return isAgentTabType(tab.type) || (tab.type === 'terminal' && !tab.cwd)
}

/** A single pane holding `tabs`, or no pane at all when there are none. */
export function singlePane(tabs: Tab[], activeTabId?: string): TaskPane[] {
  if (tabs.length === 0) return []
  const active = activeTabId && tabs.some(tab => tab.id === activeTabId) ? activeTabId : tabs[tabs.length - 1].id
  return [{ tabs, activeTabId: active, width: 1 }]
}

/** An agent session whose files live per working directory, so a move must copy them. */
export interface MovableSession {
  kind: 'claude' | 'pi'
  sessionId: string
}

/** What moving a task from `fromDir` to `toDir` has to carry along. */
export interface TaskMovePlan {
  /** Claude (CLI or chat) and Pi sessions to copy into the new directory's session folder. Codex finds its own. */
  sessions: MovableSession[]
  /** Terminals opened on a folder inside the old directory: the same folder in the new one. */
  cwdMoves: { tabId: string; cwd: string }[]
  /** Tabs whose process ends here and starts again over there. */
  restartTabIds: string[]
}

export function planTaskMove(task: Task, fromDir: string, toDir: string): TaskMovePlan {
  const sessions: MovableSession[] = []
  const cwdMoves: { tabId: string; cwd: string }[] = []
  const restartTabIds: string[] = []
  for (const tab of taskTabs(task)) {
    if ((tab.type === 'claude' || tab.type === 'claude-chat') && tab.sessionId) sessions.push({ kind: 'claude', sessionId: tab.sessionId })
    if (tab.type === 'pi' && tab.sessionId) sessions.push({ kind: 'pi', sessionId: tab.sessionId })
    if (runsInTaskDir(tab)) {
      restartTabIds.push(tab.id)
    } else if (tab.type === 'terminal' && tab.cwd) {
      const cwd = retargetPath(tab.cwd, fromDir, toDir)
      if (cwd) {
        cwdMoves.push({ tabId: tab.id, cwd })
        restartTabIds.push(tab.id)
      }
    }
  }
  return { sessions, cwdMoves, restartTabIds }
}

/**
 * The directory a tab's process runs in, or null for a tab with no process
 * there (browser, editor, note). Tab bodies are keyed on it, so a change
 * remounts them and they spawn in the new place.
 */
export function tabSpawnDir(tab: Tab, taskDir: string): string | null {
  if (tab.type === 'terminal') return tab.cwd || taskDir
  return isAgentTabType(tab.type) ? taskDir : null
}

/**
 * Pure helpers over the Project › Stream › Task model: finding and mapping tasks
 * across a project's streams, and a task's tabs. Pane layout operations (split,
 * move, resize) live in `panes.ts`.
 */
import { isAgentTabType } from './types'
import type { Project, Stream, Tab, Task, TaskPane, WorkspaceConfig } from './types'

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

/** The worktree a task works in: its stream's. */
export function taskWorkspace(project: Project | undefined | null, taskId: string | null | undefined): WorkspaceConfig | undefined {
  return findStreamOfTask(project, taskId)?.workspace
}

/**
 * The worktree that goes away with this task. TEMPORARY rule (until stream
 * archiving, step 6): a non-main stream lives while it has tasks, so removing a
 * stream's only task removes the stream, and its worktree with it.
 */
export function workspaceReleasedBy(project: Project | undefined | null, taskId: string): WorkspaceConfig | undefined {
  const stream = findStreamOfTask(project, taskId)
  if (!stream || stream.isMain || !stream.workspace) return undefined
  return stream.tasks.every(task => task.id === taskId) ? stream.workspace : undefined
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
 * Drop a task. A non-main stream left without tasks goes too (see
 * `workspaceReleasedBy`); `main` always stays.
 */
export function removeTaskFromProject(project: Project, taskId: string): Project {
  const stream = findStreamOfTask(project, taskId)
  if (!stream) return project
  const tasks = stream.tasks.filter(task => task.id !== taskId)
  const streams = tasks.length === 0 && !stream.isMain
    ? project.streams.filter(candidate => candidate !== stream)
    : project.streams.map(candidate => (
      candidate === stream
        ? { ...candidate, tasks, ...(candidate.lastTaskId === taskId ? { lastTaskId: undefined } : {}) }
        : candidate
    ))
  const next: Project = { ...project, streams }
  if (project.lastStreamId === stream.id && !streams.some(candidate => candidate.id === stream.id)) {
    delete next.lastStreamId
  }
  return next
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

/** A single pane holding `tabs`, or no pane at all when there are none. */
export function singlePane(tabs: Tab[], activeTabId?: string): TaskPane[] {
  if (tabs.length === 0) return []
  const active = activeTabId && tabs.some(tab => tab.id === activeTabId) ? activeTabId : tabs[tabs.length - 1].id
  return [{ tabs, activeTabId: active, width: 1 }]
}

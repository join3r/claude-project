/**
 * Archived tasks and streams. Closing a task or a stream archives it: it leaves
 * `projects.json` for `<config dir>/archive/<projectId>.json` (one file per
 * project, read only when a Done row is opened), and the live data keeps just a
 * count per stream (`Stream.archivedTaskCount`) and per project
 * (`Project.archivedStreamCount`) so the sidebar can say `Done (N)` without
 * reading the file.
 *
 * Every function here is pure. The data ops are idempotent (a replay that finds
 * the task already gone, or already back, is a no-op), so they can run as
 * `mutateProjects` updaters under the compare-and-swap replay. The two stores
 * are written one after the other, never together: archiving writes the file
 * first and then the data; reopening writes the data first and then the file.
 * A crash in between leaves an item in both, never in neither, and
 * {@link visibleArchive} hides an archived entry whose id is live again.
 */
import { createMainStream, isSpentEphemeralProject } from './types'
import type { PinnedItem, Project, ProjectsData, Stream, Task, WorkspaceConfig } from './types'
import { findMainStream, findStreamOfTask, findTaskInProject, removeTaskFromProject, streamDirectory } from './streams'

export const ARCHIVE_VERSION = 1

/** A task closed on its own: it sits in its stream's `Done (N)`. */
export interface ArchivedTask {
  task: Task
  /** The stream it was closed from (its `Done` row), and its name then. */
  streamId: string
  streamName: string
  /** The directory its tabs ran in, where its agent's session files live. */
  dir: string
  archivedAt: number
}

/** A stream closed with its tasks: it sits in the project's `Done` group. */
export interface ArchivedStream {
  /** As it was, with the tasks that were open when it closed. */
  stream: Stream
  /** Its own `Done` row: tasks it had archived before it closed. */
  doneTasks: ArchivedTask[]
  /** The directory its tasks ran in. */
  dir: string
  archivedAt: number
}

export interface ProjectArchive {
  version: typeof ARCHIVE_VERSION
  tasks: ArchivedTask[]
  streams: ArchivedStream[]
}

export function emptyArchive(): ProjectArchive {
  return { version: ARCHIVE_VERSION, tasks: [], streams: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTask(value: unknown): value is Task {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && Array.isArray(value.panes)
}

function normalizeArchivedTask(raw: unknown): ArchivedTask | null {
  if (!isRecord(raw) || !isTask(raw.task) || typeof raw.streamId !== 'string') return null
  return {
    task: raw.task,
    streamId: raw.streamId,
    streamName: typeof raw.streamName === 'string' ? raw.streamName : '',
    dir: typeof raw.dir === 'string' ? raw.dir : '',
    archivedAt: typeof raw.archivedAt === 'number' ? raw.archivedAt : 0
  }
}

function normalizeArchivedStream(raw: unknown): ArchivedStream | null {
  if (!isRecord(raw) || !isRecord(raw.stream)) return null
  const stream = raw.stream as Partial<Stream>
  if (typeof stream.id !== 'string' || typeof stream.name !== 'string') return null
  return {
    stream: { ...(stream as Stream), tasks: (Array.isArray(stream.tasks) ? stream.tasks : []).filter(isTask) },
    doneTasks: (Array.isArray(raw.doneTasks) ? raw.doneTasks : []).map(normalizeArchivedTask).filter((t): t is ArchivedTask => !!t),
    dir: typeof raw.dir === 'string' ? raw.dir : '',
    archivedAt: typeof raw.archivedAt === 'number' ? raw.archivedAt : 0
  }
}

/** Whatever was read off disk, as a well-formed archive (bad entries dropped). */
export function normalizeArchive(raw: unknown): ProjectArchive {
  if (!isRecord(raw)) return emptyArchive()
  return {
    version: ARCHIVE_VERSION,
    tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map(normalizeArchivedTask).filter((t): t is ArchivedTask => !!t),
    streams: (Array.isArray(raw.streams) ? raw.streams : []).map(normalizeArchivedStream).filter((s): s is ArchivedStream => !!s)
  }
}

// --- The archive file ---------------------------------------------------------

/** Add (or replace, by task id) archived tasks. */
export function withArchivedTasks(archive: ProjectArchive, entries: readonly ArchivedTask[]): ProjectArchive {
  const ids = new Set(entries.map(entry => entry.task.id))
  return { ...archive, tasks: [...archive.tasks.filter(entry => !ids.has(entry.task.id)), ...entries] }
}

/**
 * Add (or replace, by stream id) an archived stream. The tasks the stream had
 * archived before move into it: its `Done` row goes where it goes.
 */
export function withArchivedStream(archive: ProjectArchive, entry: ArchivedStream): ProjectArchive {
  const own = archive.tasks.filter(task => task.streamId === entry.stream.id)
  const doneIds = new Set(entry.doneTasks.map(task => task.task.id))
  return {
    ...archive,
    tasks: archive.tasks.filter(task => task.streamId !== entry.stream.id),
    streams: [
      ...archive.streams.filter(stream => stream.stream.id !== entry.stream.id),
      { ...entry, doneTasks: [...entry.doneTasks, ...own.filter(task => !doneIds.has(task.task.id))] }
    ]
  }
}

/** Drop archived tasks and streams by id (reopened, or deleted for good). */
export function withoutArchived(archive: ProjectArchive, ids: { tasks?: readonly string[]; streams?: readonly string[] }): ProjectArchive {
  const tasks = new Set(ids.tasks ?? [])
  const streams = new Set(ids.streams ?? [])
  return {
    ...archive,
    tasks: archive.tasks.filter(entry => !tasks.has(entry.task.id)),
    streams: archive.streams.filter(entry => !streams.has(entry.stream.id))
  }
}

/**
 * The archive as the sidebar shows it: an entry whose task or stream is live
 * again (a reopen interrupted between its two writes) is not archived.
 */
export function visibleArchive(archive: ProjectArchive, project: Project): ProjectArchive {
  const liveStreams = new Set(project.streams.map(stream => stream.id))
  const tasks = archive.tasks.filter(entry => !findTaskInProject(project, entry.task.id))
  const streams = archive.streams.filter(entry => !liveStreams.has(entry.stream.id))
  if (tasks.length === archive.tasks.length && streams.length === archive.streams.length) return archive
  return { ...archive, tasks, streams }
}

/** Archived tasks of one stream, newest first. */
export function archivedTasksOf(archive: ProjectArchive, streamId: string): ArchivedTask[] {
  return archive.tasks.filter(entry => entry.streamId === streamId).sort((a, b) => b.archivedAt - a.archivedAt)
}

/** Every tab id an archive holds, for deleting their scrollback with it. */
export function archivedTabIds(archive: ProjectArchive): string[] {
  const ids: string[] = []
  const add = (task: Task) => { for (const pane of task.panes) for (const tab of pane.tabs) ids.push(tab.id) }
  for (const entry of archive.tasks) add(entry.task)
  for (const entry of archive.streams) {
    entry.stream.tasks.forEach(add)
    entry.doneTasks.forEach(done => add(done.task))
  }
  return ids
}

// --- Building entries -----------------------------------------------------------

/** The archive entry for a live task, or null when it is not in the project. */
export function archivedTaskEntry(project: Project, taskId: string, now: number): ArchivedTask | null {
  const stream = findStreamOfTask(project, taskId)
  const task = findTaskInProject(project, taskId)
  if (!stream || !task) return null
  return { task, streamId: stream.id, streamName: stream.name, dir: streamDirectory(project, stream), archivedAt: now }
}

/** The archive entry for a live stream (never `main`), or null. */
export function archivedStreamEntry(project: Project, streamId: string, now: number): ArchivedStream | null {
  const stream = project.streams.find(candidate => candidate.id === streamId)
  if (!stream || stream.isMain) return null
  const { archivedTaskCount: _count, ...rest } = stream
  return { stream: rest, doneTasks: [], dir: streamDirectory(project, stream), archivedAt: now }
}

// --- The live data ---------------------------------------------------------------

function withoutPins(data: ProjectsData, keep: (item: PinnedItem) => boolean): PinnedItem[] {
  return (data.pinnedItems ?? []).filter(keep)
}

/** The project gone (a spent hidden one), with its order entry and pins. */
function retireProject(data: ProjectsData, projectId: string): ProjectsData {
  return {
    ...data,
    projects: data.projects.filter(candidate => candidate.id !== projectId),
    projectOrder: data.projectOrder.filter(id => id !== projectId),
    pinnedItems: (data.pinnedItems ?? []).filter(item => item.projectId !== projectId)
  }
}

/**
 * Archive tasks: each leaves its stream (which stays, even emptied) and adds one
 * to that stream's `Done (N)`; their pins go. A hidden ad-hoc project left with
 * no open task goes in the same step. Tasks already gone are skipped.
 */
export function archiveTasksInData(data: ProjectsData, projectId: string, taskIds: readonly string[]): ProjectsData {
  const project = data.projects.find(candidate => candidate.id === projectId)
  if (!project) return data
  let next = project
  const archived = new Set<string>()
  for (const taskId of taskIds) {
    const stream = findStreamOfTask(next, taskId)
    if (!stream) continue
    archived.add(taskId)
    const removed = removeTaskFromProject(next, taskId)
    next = {
      ...removed,
      streams: removed.streams.map(candidate => (
        candidate.id === stream.id ? { ...candidate, archivedTaskCount: (candidate.archivedTaskCount ?? 0) + 1 } : candidate
      ))
    }
  }
  if (archived.size === 0) return data
  if (isSpentEphemeralProject(next)) return retireProject(data, projectId)
  return {
    ...data,
    projects: data.projects.map(candidate => (candidate === project ? next : candidate)),
    pinnedItems: withoutPins(data, item => !(item.type === 'task' && item.projectId === projectId && archived.has(item.taskId)))
  }
}

/**
 * Archive a stream (never `main`) with its tasks: it leaves the project and
 * adds one to the project's `Done` group; pins on it or its tasks go. A hidden
 * ad-hoc project left with no open task goes in the same step.
 */
export function archiveStreamInData(data: ProjectsData, projectId: string, streamId: string): ProjectsData {
  const project = data.projects.find(candidate => candidate.id === projectId)
  const stream = project?.streams.find(candidate => candidate.id === streamId)
  if (!project || !stream || stream.isMain) return data
  const next: Project = {
    ...project,
    streams: project.streams.filter(candidate => candidate !== stream),
    archivedStreamCount: (project.archivedStreamCount ?? 0) + 1
  }
  if (project.lastStreamId === streamId) delete next.lastStreamId
  if (isSpentEphemeralProject(next)) return retireProject(data, projectId)
  return {
    ...data,
    projects: data.projects.map(candidate => (candidate === project ? next : candidate)),
    pinnedItems: withoutPins(data, item => item.projectId !== projectId || item.type === 'project' || item.streamId !== streamId)
  }
}

function decrement(count: number | undefined): number | undefined {
  const next = (count ?? 0) - 1
  return next > 0 ? next : undefined
}

function withCount<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): T {
  const next = { ...target }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/**
 * Where a reopened task goes: the stream it was archived from when that is
 * still open, else `main`.
 */
export function reopenTargetStream(project: Project, entry: ArchivedTask): Stream | undefined {
  return project.streams.find(stream => stream.id === entry.streamId) ?? findMainStream(project)
}

/**
 * Put an archived task back at the end of its stream (`main` when that stream
 * is gone) and take one off that stream's `Done (N)`. A replay that finds the
 * task there is a no-op.
 */
export function reopenTaskInData(data: ProjectsData, projectId: string, entry: ArchivedTask): ProjectsData {
  const project = data.projects.find(candidate => candidate.id === projectId)
  if (!project || findTaskInProject(project, entry.task.id)) return data
  const target = reopenTargetStream(project, entry)
  const streams = target
    ? project.streams.map(stream => {
        let next = stream
        if (stream.id === entry.streamId) next = withCount(next, 'archivedTaskCount', decrement(next.archivedTaskCount))
        if (stream === target) next = { ...next, tasks: [...next.tasks, entry.task] }
        return next
      })
    : [...project.streams, createMainStream(projectId, [entry.task])]
  return { ...data, projects: data.projects.map(candidate => (candidate === project ? { ...project, streams } : candidate)) }
}

/**
 * Put an archived stream back at the end of the project's streams, with the
 * tasks it had open and its own `Done (N)`, working in `workspace` (the
 * recreated worktree) or, when that is null, in the project folder. A replay
 * that finds the stream there is a no-op.
 */
export function reopenStreamInData(
  data: ProjectsData,
  projectId: string,
  entry: ArchivedStream,
  workspace: WorkspaceConfig | null
): ProjectsData {
  const project = data.projects.find(candidate => candidate.id === projectId)
  if (!project || project.streams.some(stream => stream.id === entry.stream.id)) return data
  const { workspace: _old, archivedTaskCount: _count, ...rest } = entry.stream
  const stream: Stream = {
    ...rest,
    ...(workspace ? { workspace } : {}),
    ...(entry.doneTasks.length > 0 ? { archivedTaskCount: entry.doneTasks.length } : {})
  }
  const next = withCount({ ...project, streams: [...project.streams, stream] }, 'archivedStreamCount', decrement(project.archivedStreamCount))
  return { ...data, projects: data.projects.map(candidate => (candidate === project ? next : candidate)) }
}

/**
 * The counts in the live data set to what the archive file holds (they drift
 * only when a write was interrupted). Returns `data` itself when they agree.
 */
export function syncArchiveCounts(data: ProjectsData, projectId: string, archive: ProjectArchive): ProjectsData {
  const project = data.projects.find(candidate => candidate.id === projectId)
  if (!project) return data
  const visible = visibleArchive(archive, project)
  let changed = false
  const streams = project.streams.map(stream => {
    const count = visible.tasks.filter(entry => entry.streamId === stream.id).length || undefined
    if (count === stream.archivedTaskCount) return stream
    changed = true
    return withCount(stream, 'archivedTaskCount', count)
  })
  const streamCount = visible.streams.length || undefined
  if (!changed && streamCount === project.archivedStreamCount) return data
  const next = withCount({ ...project, streams }, 'archivedStreamCount', streamCount)
  return { ...data, projects: data.projects.map(candidate => (candidate === project ? next : candidate)) }
}

/** Projects in `before` that `after` no longer has: their archives go with them. */
export function vanishedProjectIds(before: readonly Project[], after: readonly Project[]): string[] {
  const kept = new Set(after.map(project => project.id))
  return before.filter(project => !kept.has(project.id)).map(project => project.id)
}

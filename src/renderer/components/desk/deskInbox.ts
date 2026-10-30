/**
 * The desk column's lists (2026-10-30 redesign): the classic Inbox partition
 * regrouped into mail-style tabs. Pure, so the rules can be tested without a
 * renderer.
 *
 *  - Inbox: Needs you (a question, a permission, a landing that stopped) ·
 *    Answered (the agent finished and you haven't replied) · Waiting on you
 *    (idle: you had the last word, or nothing ran yet).
 *  - Working: agents running, a landing being fixed by its agent included.
 *  - Snoozed: as the classic Inbox; a live agent still wins over snooze.
 *  - Done: archived tasks, read separately (see `doneEntries`).
 */
import type { DeskScope, DeskTab, Project, Stream } from '../../../shared/types'
import type { ArchivedTask, ProjectArchive } from '../../../shared/archive'
import { landingNeedsYou, type InboxEntry, type InboxPartition, type InboxSource } from '../inbox'

export interface DeskLists {
  needsYou: InboxEntry[]
  answered: InboxEntry[]
  waiting: InboxEntry[]
  working: InboxEntry[]
  snoozed: InboxEntry[]
}

/** Only the tasks inside `scope` (all of them when it is null). */
export function scopeSources(sources: readonly InboxSource[], scope: DeskScope | null | undefined): InboxSource[] {
  if (!scope) return [...sources]
  return sources.filter(({ project, stream }) =>
    project.id === scope.projectId && (!scope.streamId || stream.id === scope.streamId))
}

export function deskLists(partition: InboxPartition): DeskLists {
  const needsYou = [...partition.needsYou]
  const answered: InboxEntry[] = []
  const waiting: InboxEntry[] = []
  for (const entry of partition.ready) {
    if (landingNeedsYou(entry.task)) needsYou.push(entry)
    else if (entry.yourTurn) answered.push(entry)
    else waiting.push(entry)
  }
  return { needsYou, answered, waiting, working: partition.working, snoozed: partition.snoozed }
}

/** The tab badges: Inbox counts unread rows only (like mail), Working counts rows; the rest show none. */
export function deskTabCounts(lists: DeskLists): Record<DeskTab, number | null> {
  const inboxRows = [...lists.needsYou, ...lists.answered, ...lists.waiting]
  return {
    inbox: inboxRows.filter(entry => entry.unread || entry.status === 'attention').length,
    working: lists.working.length,
    snoozed: null,
    done: null
  }
}

/** The rows a tab lists, in order (Done has its own source). */
export function deskTabEntries(lists: DeskLists, tab: DeskTab): InboxEntry[] {
  switch (tab) {
    case 'inbox': return [...lists.needsYou, ...lists.answered, ...lists.waiting]
    case 'working': return lists.working
    case 'snoozed': return lists.snoozed
    case 'done': return []
  }
}

export interface DoneEntry {
  project: Project
  entry: ArchivedTask
}

export const DONE_WINDOW_MS = 30 * 24 * 60 * 60_000

/**
 * Archived tasks of `projects`, newest first. Tasks closed on their own and the
 * tasks of closed streams both count. `since` cuts the list (the last 30 days,
 * until "Show older"); null keeps everything.
 */
export function doneEntries(
  projects: readonly Project[],
  archives: ReadonlyMap<string, ProjectArchive>,
  scope: DeskScope | null | undefined,
  since: number | null
): DoneEntry[] {
  const out: DoneEntry[] = []
  for (const project of projects) {
    if (scope && project.id !== scope.projectId) continue
    const archive = archives.get(project.id)
    if (!archive) continue
    const liveTaskIds = new Set(project.streams.flatMap(stream => stream.tasks.map(task => task.id)))
    const push = (entry: ArchivedTask): void => {
      if (liveTaskIds.has(entry.task.id)) return
      if (scope?.streamId && entry.streamId !== scope.streamId) return
      if (since !== null && entry.archivedAt < since) return
      out.push({ project, entry })
    }
    archive.tasks.forEach(push)
    for (const closed of archive.streams) {
      closed.doneTasks.forEach(push)
      for (const task of closed.stream.tasks) {
        push({ task, streamId: closed.stream.id, streamName: closed.stream.name, dir: closed.dir, archivedAt: closed.archivedAt })
      }
    }
  }
  return out.sort((a, b) => b.entry.archivedAt - a.entry.archivedAt)
}

/** What the scope menu and compose chip say: "All projects", "devtool", "devtool › 0.7.0". */
export function scopeLabel(projects: readonly Project[], scope: DeskScope | null | undefined): string {
  if (!scope) return 'All projects'
  const project = projects.find(p => p.id === scope.projectId)
  if (!project) return 'All projects'
  const stream = scope.streamId ? project.streams.find(s => s.id === scope.streamId) : undefined
  return stream && !stream.isMain ? `${project.name} › ${stream.name}` : project.name
}

/**
 * Where compose sends a task by default: the scope's stream, the scope's
 * project (its main stream), or with no scope the project last fired into.
 */
export function composeTarget(
  projects: readonly Project[],
  scope: DeskScope | null | undefined,
  lastProjectId: string | null | undefined
): { project: Project; stream: Stream | undefined } | null {
  const pick = (id: string | null | undefined): Project | undefined => (id ? projects.find(p => p.id === id) : undefined)
  const project = pick(scope?.projectId) ?? pick(lastProjectId) ?? projects[0]
  if (!project) return null
  const stream = scope?.projectId === project.id && scope.streamId
    ? project.streams.find(s => s.id === scope.streamId)
    : undefined
  return { project, stream }
}

/** The task a row key acts on: the hovered row, else the selected one, when either is listed. */
export function keyTarget(entries: readonly InboxEntry[], hoveredTaskId: string | null, selectedTaskId: string | null): InboxEntry | null {
  const find = (id: string | null): InboxEntry | undefined => (id ? entries.find(entry => entry.task.id === id) : undefined)
  return find(hoveredTaskId) ?? find(selectedTaskId) ?? null
}


/**
 * Pure helpers behind the sidebar's Project › Stream › Task tree: a task's state
 * dot, a stream's rolled-up state, which streams auto-collapse, and where a
 * dragged task lands. No React, so all of it is unit-tested directly.
 */
import type { Stream, TabStatusValue, Task } from '../../../shared/types'
import { taskTabs } from '../../../shared/streams'
import { isSettled, isSnoozed, isUnread, lastActivityAt, statusTabs } from '../../../shared/inbox-state'

/** What a task's dot shows, strongest first. `null` is a quiet task. */
export type SidebarTaskState = 'attention' | 'working' | 'unread' | 'exited' | null

const STATE_RANK: Record<Exclude<SidebarTaskState, null>, number> = {
  attention: 4,
  working: 3,
  unread: 2,
  exited: 1
}

function stateRank(state: SidebarTaskState): number {
  return state ? STATE_RANK[state] : 0
}

/**
 * The task's state: the live status of its status tabs (`statusTabs`: main tab
 * and agent tabs, so a terminal task's bell counts), else unread when something happened since you
 * last looked. A settled or snoozed task is not unread here: you put it away.
 */
export function sidebarTaskState(
  task: Task,
  allStatuses: Record<string, TabStatusValue>,
  now: number
): SidebarTaskState {
  let live: TabStatusValue = null
  for (const tab of statusTabs(task)) {
    const status = allStatuses[tab.id] ?? null
    if (stateRank(status) > stateRank(live)) live = status
  }
  if (live === 'attention' || live === 'working') return live
  if (isUnread(task) && !isSettled(task) && !isSnoozed(task, now)) return 'unread'
  return live
}

/** The strongest of `states`, so a collapsed stream still shows that something needs you. */
export function rollUpState(states: readonly SidebarTaskState[]): SidebarTaskState {
  let best: SidebarTaskState = null
  for (const state of states) {
    if (stateRank(state) > stateRank(best)) best = state
  }
  return best
}

/** A task worth keeping in view: it needs you, is running, or has news. */
export function isLiveState(state: SidebarTaskState): boolean {
  return state === 'attention' || state === 'working' || state === 'unread'
}

/** No task in the stream needs you, runs or has news. */
export function isQuietStream(stream: Stream, stateOf: (task: Task) => SidebarTaskState): boolean {
  return !stream.tasks.some(task => isLiveState(stateOf(task)))
}

/**
 * Whether a stream shows its tasks. A chevron click (`override`) wins; otherwise
 * auto-collapse folds quiet streams, except the one holding the selected task.
 */
export function isStreamExpanded({
  override,
  autoCollapse,
  quiet,
  holdsSelection
}: {
  override: boolean | undefined
  autoCollapse: boolean
  quiet: boolean
  holdsSelection: boolean
}): boolean {
  if (override !== undefined) return override
  if (!autoCollapse) return true
  return !quiet || holdsSelection
}

/** Tabs beyond the one the task is about, for the row's `+N`. */
export function extraTabCount(task: Task): number {
  return Math.max(0, taskTabs(task).length - 1)
}

/** "4m", "3h", "2d" since the task last saw activity; null when it never did. */
export function formatActivityAge(task: Task, now: number): string | null {
  const at = lastActivityAt(task)
  if (!at) return null
  const elapsed = Math.max(0, now - at)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < hour) return `${Math.max(1, Math.round(elapsed / minute))}m`
  if (elapsed < day) return `${Math.round(elapsed / hour)}h`
  return `${Math.round(elapsed / day)}d`
}

// --- Dragging tasks between streams ----------------------------------------

/** A row of one project's tree, as laid out on screen. */
export interface TreeRowLayout {
  kind: 'stream' | 'task'
  streamId: string
  /** For a task row: its index in its stream. */
  index: number
  /** For a task row: the task id. */
  taskId?: string
  /** For a stream row: how many tasks the stream holds. */
  taskCount?: number
  top: number
  height: number
}

/**
 * Where a task dropped at `cursorY` goes: `index` counts the target stream's
 * tasks as they are now, the dragged one included. `onStreamRow` means the
 * cursor is over a stream's own row, which appends to that stream.
 */
export interface TaskDropSlot {
  streamId: string
  index: number
  onStreamRow: boolean
}

export function taskDropSlot(rows: readonly TreeRowLayout[], cursorY: number): TaskDropSlot | null {
  if (rows.length === 0) return null
  const hit = rows.find(row => cursorY >= row.top && cursorY < row.top + row.height)
    ?? (cursorY < rows[0].top ? rows[0] : rows[rows.length - 1])
  if (hit.kind === 'stream') {
    return { streamId: hit.streamId, index: hit.taskCount ?? 0, onStreamRow: true }
  }
  const after = cursorY >= hit.top + hit.height / 2
  return { streamId: hit.streamId, index: hit.index + (after ? 1 : 0), onStreamRow: false }
}

/**
 * The move a drop asks for: the target stream and the index to insert at once
 * the task has left its old place. Null when the drop leaves it where it is.
 */
export function resolveTaskMove(
  from: { streamId: string; index: number },
  slot: TaskDropSlot
): { toStreamId: string; toIndex: number } | null {
  if (slot.streamId !== from.streamId) return { toStreamId: slot.streamId, toIndex: slot.index }
  if (slot.index === from.index || slot.index === from.index + 1) return null
  return { toStreamId: slot.streamId, toIndex: slot.index > from.index ? slot.index - 1 : slot.index }
}

import type { Project, Stream, Task } from '../../shared/types'
import type { TabStatusValue } from '../context/TabStatusContext'
import {
  inboxState,
  isSettled,
  isSnoozed,
  isStatusTab,
  isUnread,
  isYourTurn,
  landingNeedsYou,
  landingStatusLabel,
  lastActivityAt,
  statusTabs,
  taskStatus
} from '../../shared/inbox-state'
import { describeActivity, type AgentActivity } from '../../shared/agent-activity'

// The triage predicates themselves moved to shared/inbox-state.ts when idle
// cleanup moved into main — both processes must answer them identically. They
// are re-exported here because this module is the inbox's façade.
export {
  inboxState, isSettled, isSnoozed, isStatusTab, isUnread, isYourTurn, landingNeedsYou, landingStatusLabel, lastActivityAt, statusTabs, taskStatus
}

/** Oldest `since` stamp across the task's status tabs — how long it has been waiting. */
export function taskStatusSince(
  task: Task,
  allStatuses: Record<string, TabStatusValue>,
  statusSince: Record<string, number>
): number | null {
  const status = taskStatus(task, allStatuses)
  if (!status) return null
  const stamps = statusTabs(task)
    .filter((tab) => allStatuses[tab.id] === status)
    .map((tab) => statusSince[tab.id])
    .filter((stamp): stamp is number => typeof stamp === 'number')
  if (stamps.length === 0) return null
  return Math.min(...stamps)
}

export interface TaskActivitySummary {
  /** One line for the row: "Bash · npm test", "Permission: Edit a.ts", the last reply. */
  line?: string
  /** Multi-line hover text: session title, your last prompt, Claude's last reply. */
  tooltip?: string
}

const STATUS_RANK: Record<string, number> = { attention: 3, working: 2, exited: 1 }

/**
 * The activity of the task's most relevant status tab: the one that needs you,
 * else the one working, else whichever reported last. A task is one agent, but
 * an extra agent tab opened beside it still reports, so pick the line you would
 * act on.
 */
export function taskActivity(
  task: Task,
  allStatuses: Record<string, TabStatusValue>,
  activities: Record<string, AgentActivity>
): TaskActivitySummary {
  let best: { activity: AgentActivity; status: TabStatusValue; rank: number } | null = null
  for (const tab of statusTabs(task)) {
    const activity = activities[tab.id]
    if (!activity) continue
    const status = allStatuses[tab.id] ?? null
    const rank = status ? STATUS_RANK[status] ?? 0 : 0
    if (!best || rank > best.rank || (rank === best.rank && activity.updatedAt > best.activity.updatedAt)) {
      best = { activity, status, rank }
    }
  }
  if (!best) return {}

  const { activity, status } = best
  const tooltip = [
    activity.title,
    activity.lastPrompt && `You: ${activity.lastPrompt}`,
    activity.lastMessage && `Claude: ${activity.lastMessage}`
  ].filter(Boolean).join('\n')
  return { line: describeActivity(activity, status), tooltip: tooltip || undefined }
}

/** A task with where it lives, as the Inbox lists it. */
export interface InboxSource {
  task: Task
  project: Project
  stream: Stream
}

export interface InboxEntry extends InboxSource {
  status: TabStatusValue
  /** When the current status began — null when unknown (e.g. after a restart). */
  since: number | null
  unread: boolean
  /** Waiting on you rather than the agent — see isYourTurn. Never set on quiet settled or snoozed rows. */
  yourTurn: boolean
}

export interface InboxPartition {
  /** Blocked on you: a question, a permission prompt, a terminal bell. */
  needsYou: InboxEntry[]
  /**
   * The agent is idle and you can act. Rows waiting on your reply (`yourTurn`:
   * the agent finished and you haven't answered, or its landing stopped) come
   * first, then the rest, where you had the last word or nothing happened yet.
   */
  ready: InboxEntry[]
  /** The agent is running: nothing for you to do yet. */
  working: InboxEntry[]
  settled: InboxEntry[]
  snoozed: InboxEntry[]
}

/**
 * Splits tasks into the inbox groups. A live agent wins over snooze and settle:
 * a task that needs you or is working shows there, the same as its header chip,
 * and drops back to Snoozed / Done for now once the agent goes quiet. So does a
 * landing stopped on a conflict or a blocked stream (Ready). Snooze wins over
 * settle (an explicitly snoozed task stays hidden even if it was settled earlier).
 */
export function partitionInbox(
  entries: readonly InboxSource[],
  allStatuses: Record<string, TabStatusValue>,
  statusSince: Record<string, number>,
  now: number
): InboxPartition {
  const partition: InboxPartition = { needsYou: [], ready: [], working: [], settled: [], snoozed: [] }
  const yourTurn: InboxEntry[] = []
  const idle: InboxEntry[] = []

  for (const { task, project, stream } of entries) {
    const status = taskStatus(task, allStatuses)
    const entry: InboxEntry = {
      task,
      project,
      stream,
      status,
      since: taskStatusSince(task, allStatuses, statusSince),
      unread: isUnread(task),
      yourTurn: false
    }
    if (status === 'attention') {
      entry.yourTurn = true
      partition.needsYou.push(entry)
    } else if (landingNeedsYou(task)) {
      // A stopped landing waits for you whatever else goes on (a busy terminal) or was put away.
      entry.yourTurn = true
      yourTurn.push(entry)
    } else if (status === 'working') partition.working.push(entry)
    else if (isSnoozed(task, now)) partition.snoozed.push(entry)
    else if (isSettled(task)) partition.settled.push(entry)
    else {
      entry.yourTurn = isYourTurn(task, status)
      if (entry.yourTurn) yourTurn.push(entry)
      else idle.push(entry)
    }
  }

  const byRecency = (a: InboxEntry, b: InboxEntry): number => lastActivityAt(b.task) - lastActivityAt(a.task)
  // Longest wait first — the point of the tier is surfacing what has been blocked longest.
  partition.needsYou.sort((a, b) => (a.since ?? now) - (b.since ?? now))
  partition.ready = [...yourTurn.sort(byRecency), ...idle.sort(byRecency)]
  // Newest start first, so a task you just sent a prompt to lands at the top.
  partition.working.sort((a, b) => (b.since ?? lastActivityAt(b.task)) - (a.since ?? lastActivityAt(a.task)))
  partition.settled.sort((a, b) => (inboxState(b.task).settledAt ?? 0) - (inboxState(a.task).settledAt ?? 0))
  partition.snoozed.sort((a, b) => wakeAt(a.task) - wakeAt(b.task))

  return partition
}

/**
 * Every task of `projects` with its project and stream, in sidebar order.
 * Archived tasks live in `archive/<projectId>.json`, outside `streams`, so they
 * never get here.
 */
export function inboxSources(projects: readonly Project[]): InboxSource[] {
  const sources: InboxSource[] = []
  for (const project of projects) {
    for (const stream of project.streams) {
      for (const task of stream.tasks) sources.push({ task, project, stream })
    }
  }
  return sources
}

export interface InboxProjectGroup {
  project: Project
  entries: InboxEntry[]
}

/**
 * Rows gathered by project for the grouped Inbox layout (the stream is a label on
 * each row). A group sits where its most urgent row would sit in the flat list
 * and keeps that list's order inside, so grouping never buries a task that needs
 * you under a busier project.
 */
export function groupInboxByProject(entries: readonly InboxEntry[]): InboxProjectGroup[] {
  const groups = new Map<string, InboxProjectGroup>()
  for (const entry of entries) {
    let group = groups.get(entry.project.id)
    if (!group) {
      group = { project: entry.project, entries: [] }
      groups.set(entry.project.id, group)
    }
    group.entries.push(entry)
  }
  return [...groups.values()]
}

/** Sort key for the snoozed group; "until it needs me" has no clock, so it sorts last. */
function wakeAt(task: Task): number {
  return inboxState(task).snoozedUntil ?? Number.MAX_SAFE_INTEGER
}

export interface SnoozePreset {
  id: string
  label: string
  /** Absolute wake time; undefined for the event-driven preset. */
  until?: number
  untilAttention?: boolean
  /** Clock hint shown right-aligned in the menu. */
  hint?: string
}

function atHour(now: number, dayOffset: number, hour: number): number {
  const date = new Date(now)
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hour, 0, 0, 0)
  return date.getTime()
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function snoozePresets(now: number): SnoozePreset[] {
  const presets: SnoozePreset[] = [
    { id: 'attention', label: 'Until it needs me', untilAttention: true },
    { id: 'hour', label: '1 hour', until: now + 60 * 60_000 }
  ]

  const evening = atHour(now, 0, 18)
  if (evening > now) presets.push({ id: 'evening', label: 'This evening', until: evening, hint: formatClock(evening) })

  const tomorrow = atHour(now, 1, 9)
  presets.push({ id: 'tomorrow', label: 'Tomorrow', until: tomorrow, hint: formatClock(tomorrow) })

  // Next Monday; if today is Monday we mean the one a week out, not today.
  const dayOfWeek = new Date(now).getDay()
  const daysToMonday = ((8 - dayOfWeek) % 7) || 7
  const monday = atHour(now, daysToMonday, 9)
  presets.push({ id: 'monday', label: 'Monday', until: monday, hint: formatClock(monday) })

  return presets
}

/** Compact duration for "waiting 4m" / "waiting 2h" style labels. */
export function formatWaitTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Relative age for the right-hand timestamp on each row. */
export function formatRelativeAge(ms: number): string {
  if (ms < 60_000) return 'now'
  return formatWaitTime(ms)
}

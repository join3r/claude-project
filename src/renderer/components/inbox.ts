import type { Project, Task } from '../../shared/types'
import type { TabStatusValue } from '../context/TabStatusContext'
import { inboxState, isSettled, isSnoozed, isUnread, isYourTurn, lastActivityAt, taskStatus } from '../../shared/inbox-state'
import { describeActivity, type AgentActivity } from '../../shared/agent-activity'

// The triage predicates themselves moved to shared/inbox-state.ts when idle
// cleanup moved into main — both processes must answer them identically. They
// are re-exported here because this module is the inbox's façade.
export { inboxState, isSettled, isSnoozed, isUnread, isYourTurn, lastActivityAt, taskStatus }

/** Oldest `since` stamp across the task's AI tabs — how long it has been waiting. */
export function taskStatusSince(
  task: Task,
  allStatuses: Record<string, TabStatusValue>,
  statusSince: Record<string, number>
): number | null {
  const status = taskStatus(task, allStatuses)
  if (!status) return null
  const stamps = [...task.tabs.left, ...task.tabs.right]
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
 * The activity of the task's most relevant agent tab: the one that needs you, else
 * the one working, else whichever reported last. Tasks with several Claude tabs
 * show one line, so it has to be the line you would act on.
 */
export function taskActivity(
  task: Task,
  allStatuses: Record<string, TabStatusValue>,
  activities: Record<string, AgentActivity>
): TaskActivitySummary {
  let best: { activity: AgentActivity; status: TabStatusValue; rank: number } | null = null
  for (const tab of [...task.tabs.left, ...task.tabs.right]) {
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

export interface InboxEntry {
  task: Task
  project: Project
  status: TabStatusValue
  /** When the current status began — null when unknown (e.g. after a restart). */
  since: number | null
  unread: boolean
  /** Waiting on you rather than the agent — see isYourTurn. Never set on settled or snoozed rows. */
  yourTurn: boolean
}

export interface InboxPartition {
  needsYou: InboxEntry[]
  active: InboxEntry[]
  settled: InboxEntry[]
  snoozed: InboxEntry[]
}

/**
 * Splits tasks into the four inbox groups. Snooze wins over settle: an explicitly
 * snoozed task stays hidden even if it was settled earlier.
 */
export function partitionInbox(
  entries: { task: Task; project: Project }[],
  allStatuses: Record<string, TabStatusValue>,
  statusSince: Record<string, number>,
  now: number
): InboxPartition {
  const needsYou: InboxEntry[] = []
  const active: InboxEntry[] = []
  const settled: InboxEntry[] = []
  const snoozed: InboxEntry[] = []

  for (const { task, project } of entries) {
    const status = taskStatus(task, allStatuses)
    const entry: InboxEntry = {
      task,
      project,
      status,
      since: taskStatusSince(task, allStatuses, statusSince),
      unread: isUnread(task),
      yourTurn: false
    }
    if (isSnoozed(task, now)) snoozed.push(entry)
    else if (isSettled(task)) settled.push(entry)
    else {
      entry.yourTurn = isYourTurn(task, status)
      if (status === 'attention') needsYou.push(entry)
      else active.push(entry)
    }
  }

  // Longest wait first — the point of the tier is surfacing what has been blocked longest.
  needsYou.sort((a, b) => (a.since ?? now) - (b.since ?? now))
  active.sort((a, b) => lastActivityAt(b.task) - lastActivityAt(a.task))
  settled.sort((a, b) => (inboxState(b.task).settledAt ?? 0) - (inboxState(a.task).settledAt ?? 0))
  snoozed.sort((a, b) => wakeAt(a.task) - wakeAt(b.task))

  return { needsYou, active, settled, snoozed }
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

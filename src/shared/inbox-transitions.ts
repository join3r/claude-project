/**
 * Pure transitions of a task's inbox triage state. Each takes the current
 * `TaskInboxState` and returns a new one; timestamps are passed in so the
 * caller decides whether "now" is taken at call time or at replay time.
 *
 * Shared because the window applies them to its own triage and main applies
 * them for the phone (`task.triage`, SPEC.md §8.11).
 */
import type { TaskInboxState } from './types'

export type TaskEventKind = 'event' | 'attention'

/**
 * A meaningful event on a task: a hook notification/stop, a terminal bell, a PTY
 * exit. 'attention' additionally records the moment something started waiting on
 * the user, which is what "snooze until it needs me" wakes on.
 *
 * Also resolves triage state that the event supersedes: a settle is undone (settle
 * means "done for now", not "muted"), and an attention-snooze is woken. `watching`
 * marks it read on arrival, for the task on screen.
 */
export function inboxWithEvent(
  inbox: TaskInboxState,
  now: number,
  kind: TaskEventKind,
  watching: boolean
): TaskInboxState {
  const next: TaskInboxState = { ...inbox, eventAt: now }
  if (kind === 'attention') next.attentionAt = now
  if (watching) next.visitedAt = now
  if (typeof next.settledAt === 'number') delete next.settledAt
  if (kind === 'attention' && next.snoozeUntilAttention) {
    delete next.snoozeUntilAttention
    delete next.snoozedAt
  }
  return next
}

export function inboxVisited(inbox: TaskInboxState, now: number): TaskInboxState {
  const next: TaskInboxState = { ...inbox, visitedAt: now }
  delete next.forcedUnread
  return next
}

export function inboxUnread(inbox: TaskInboxState): TaskInboxState {
  return { ...inbox, forcedUnread: true }
}

/** Settling is also an acknowledgement, so it clears unread and any snooze. */
export function inboxSettled(inbox: TaskInboxState, now: number): TaskInboxState {
  const next: TaskInboxState = { ...inbox, settledAt: now, visitedAt: now }
  delete next.forcedUnread
  delete next.snoozedUntil
  delete next.snoozeUntilAttention
  delete next.snoozedAt
  return next
}

export function inboxUnsettled(inbox: TaskInboxState): TaskInboxState {
  const next = { ...inbox }
  delete next.settledAt
  return next
}

export interface SnoozeOptions {
  until?: number
  untilAttention?: boolean
}

export function inboxSnoozed(inbox: TaskInboxState, now: number, options: SnoozeOptions): TaskInboxState {
  const next: TaskInboxState = { ...inbox, snoozedAt: now, visitedAt: now }
  delete next.forcedUnread
  delete next.settledAt
  if (options.untilAttention) {
    next.snoozeUntilAttention = true
    delete next.snoozedUntil
  } else {
    next.snoozedUntil = options.until
    delete next.snoozeUntilAttention
  }
  return next
}

export function inboxUnsnoozed(inbox: TaskInboxState): TaskInboxState {
  const next = { ...inbox }
  delete next.snoozedUntil
  delete next.snoozeUntilAttention
  delete next.snoozedAt
  return next
}

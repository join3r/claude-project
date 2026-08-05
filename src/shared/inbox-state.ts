import type { Task, TabStatusValue, TaskInboxState } from './types'

/**
 * The triage predicates the inbox is built on. They live in shared rather than
 * next to the inbox UI because idle cleanup runs in main now and has to answer
 * "is this unread / snoozed / settled / busy?" exactly the way the window does —
 * a second implementation would be a silent blind spot the moment the two drift.
 *
 * `src/renderer/components/inbox.ts` re-exports every one of these.
 */

const EMPTY_INBOX: TaskInboxState = {}

export function inboxState(task: Task): TaskInboxState {
  return task.inbox ?? EMPTY_INBOX
}

/**
 * Unread until you visit the task. A manual "mark unread" wins until the next visit,
 * which is the whole point of it.
 */
export function isUnread(task: Task): boolean {
  const inbox = inboxState(task)
  if (inbox.forcedUnread) return true
  if (typeof inbox.eventAt !== 'number') return false
  return inbox.eventAt > (inbox.visitedAt ?? 0)
}

/**
 * Settled means "done for now", not "muted": any event that lands after the settle
 * un-settles the task so a live agent can never be buried by accident.
 */
export function isSettled(task: Task): boolean {
  const inbox = inboxState(task)
  if (typeof inbox.settledAt !== 'number') return false
  if (typeof inbox.eventAt === 'number' && inbox.eventAt > inbox.settledAt) return false
  return true
}

/**
 * Snooze is the verb that survives events — otherwise it would be indistinguishable
 * from settle. "Until it needs me" waits for an attention event specifically (a
 * question or permission prompt), ignoring a plain "agent finished".
 */
export function isSnoozed(task: Task, now: number): boolean {
  const inbox = inboxState(task)
  if (inbox.snoozeUntilAttention) {
    const snoozedAt = inbox.snoozedAt ?? 0
    return !(typeof inbox.attentionAt === 'number' && inbox.attentionAt > snoozedAt)
  }
  if (typeof inbox.snoozedUntil !== 'number') return false
  return now < inbox.snoozedUntil
}

/**
 * Rolls the per-tab statuses of a task up to a single task status. Unlike the
 * project tree's dot, this covers *every* tab, not just AI ones: the inbox lists
 * terminal-only tasks too.
 *
 * Terminal tabs are deliberately still allowed to push a task into "Needs you".
 * That was wrong while terminal 'attention' meant "a line matched /error|fail/" —
 * a test run or a stack trace read as "an agent is blocked on you". Since
 * terminalStatus.ts now sets it only on a real terminal bell, it is a program
 * deliberately asking for the user, which is exactly what the tier means. If the
 * bell ever proves noisy, filter here (by tab type) rather than by weakening
 * the tab's own dot.
 */
export function taskStatus(task: Task, allStatuses: Record<string, TabStatusValue>): TabStatusValue {
  const tabIds = [...task.tabs.left, ...task.tabs.right].map((tab) => tab.id)
  if (tabIds.length === 0) return null
  const statuses = tabIds.map((id) => allStatuses[id]).filter(Boolean)
  if (statuses.includes('attention')) return 'attention'
  if (statuses.includes('working')) return 'working'
  if (statuses.includes('exited')) return 'exited'
  return null
}

/** Last time anything happened in a task, whether we caused it or the agent did. */
export function lastActivityAt(task: Task): number {
  return Math.max(inboxState(task).eventAt ?? 0, task.lastInteractedAt ?? 0)
}

import { resolveMainTabId, taskTabs } from './streams'
import { isAgentTabType } from './types'
import type { Tab, Task, TabStatusValue, TaskInboxState, TaskLanding } from './types'

/**
 * The triage predicates the inbox is built on. They live in shared rather than
 * next to the inbox UI because main builds the phone's inbox and has to answer
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
 * Snooze is the verb that survives plain events — otherwise it would be
 * indistinguishable from settle. An attention event (a question or permission
 * prompt) wakes any snooze, timed or "until it needs me"; a plain "agent
 * finished" does not.
 */
export function isSnoozed(task: Task, now: number): boolean {
  const inbox = inboxState(task)
  if (!inbox.snoozeUntilAttention && typeof inbox.snoozedUntil !== 'number') return false
  const snoozedAt = inbox.snoozedAt ?? 0
  if (typeof inbox.attentionAt === 'number' && inbox.attentionAt > snoozedAt) return false
  if (inbox.snoozeUntilAttention) return true
  if (typeof inbox.snoozedUntil !== 'number') return false
  return now < inbox.snoozedUntil
}

/**
 * The tabs whose live status is the task's status: its main tab (the agent, or
 * the terminal of a terminal task) and any agent tab. Extra terminals, browsers
 * and editors are the task's tools, not the task: a dev server's output or a
 * test run's bell in a side terminal doesn't make the task need you.
 *
 * A terminal task's main terminal is allowed to push it into "Needs you":
 * terminalStatus.ts sets 'attention' only on a real terminal bell, which is a
 * program deliberately asking for the user, exactly what the tier means.
 *
 * The sidebar's dot (`sidebarTaskState`) and the Inbox both read this, so a
 * task never shows one state in the tree and another in the Inbox.
 */
export function statusTabs(task: Task): Tab[] {
  const tabs = taskTabs(task)
  const mainTabId = resolveMainTabId(tabs, task.mainTabId)
  return tabs.filter((tab) => tab.id === mainTabId || isAgentTabType(tab.type))
}

/** Whether `tabId`'s status and events count for its task (see `statusTabs`). */
export function isStatusTab(task: Task, tabId: string): boolean {
  return statusTabs(task).some((tab) => tab.id === tabId)
}

/** The strongest live status of the task's status tabs: attention, then working, then exited. */
export function taskStatus(task: Task, allStatuses: Record<string, TabStatusValue>): TabStatusValue {
  const statuses = statusTabs(task).map((tab) => allStatuses[tab.id]).filter(Boolean)
  if (statuses.includes('attention')) return 'attention'
  if (statuses.includes('working')) return 'working'
  if (statuses.includes('exited')) return 'exited'
  return null
}

/** Last time anything happened in a task, whether we caused it or the agent did. */
export function lastActivityAt(task: Task): number {
  return Math.max(inboxState(task).eventAt ?? 0, task.lastInteractedAt ?? 0)
}

/**
 * The task's landing into its stream stopped and waits for you: a rebase
 * conflict, or the stream's worktree in the way. Unlike an agent's turn this
 * holds until the landing is retried or aborted, whatever you type meanwhile.
 * (`fixing` is the agent's, and `landing` is still running.)
 */
export function landingNeedsYou(task: Task): boolean {
  const state = task.landing?.state
  return state === 'conflict' || state === 'blocked'
}

/**
 * One line for where a task's landing is, naming the stream: "conflicts with
 * 0.5.0 in 2 files", "landing into 0.5.0…". Null when it isn't landing.
 */
export function landingStatusLabel(landing: TaskLanding | undefined, streamName: string): string | null {
  if (!landing) return null
  const files = landing.files?.length ?? 0
  const inFiles = files === 0 ? '' : files === 1 ? ' in 1 file' : ` in ${files} files`
  switch (landing.state) {
    case 'landing':
      return landing.intent === 'update' ? `updating from ${streamName}…` : `landing into ${streamName}…`
    case 'conflict':
      return `conflicts with ${streamName}${inFiles}`
    case 'fixing':
      return `agent fixing conflicts with ${streamName}`
    case 'blocked':
      return files > 0 ? `${streamName} has local changes${inFiles}` : `can't land into ${streamName}`
  }
}

/**
 * The ball is in your court: the agent is not running, and the last thing that
 * happened in the task was the agent (a Stop, a question, a bell, an exit) rather
 * than you. Unlike unread this survives a visit — looking at the reply is not
 * answering it. Typing into the task (or settling/snoozing it) hands it back.
 * A stopped landing (`landingNeedsYou`) is your turn too, even while a tab
 * works: nothing lands until you retry or abort it.
 */
export function isYourTurn(task: Task, status: TabStatusValue): boolean {
  if (landingNeedsYou(task)) return true
  if (status === 'working') return false
  if (status === 'attention') return true
  const eventAt = inboxState(task).eventAt
  if (typeof eventAt !== 'number') return false
  return eventAt > (task.lastInteractedAt ?? 0)
}

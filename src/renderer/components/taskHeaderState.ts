import { AI_TAB_META, CLAUDE_CHAT_LABEL, isAgentTabType } from '../../shared/types'
import type { AiTabType, Tab, TabStatusValue, Task } from '../../shared/types'
import { resolveMainTabId, taskTabs } from '../../shared/streams'
import { formatWaitTime, isSettled, isSnoozed, isYourTurn, taskStatus, taskStatusSince } from './inbox'

/** The task's agent tab: its main tab when that is an agent, else the first agent tab. */
export function taskAgentTab(task: Task): Tab | undefined {
  const tabs = taskTabs(task)
  const mainTabId = resolveMainTabId(tabs, task.mainTabId)
  return tabs.find(tab => tab.id === mainTabId && isAgentTabType(tab.type)) ?? tabs.find(tab => isAgentTabType(tab.type))
}

/** What the header calls the task's agent: Claude (chat), Claude Code, Codex, Pi; Terminal for a terminal task. */
export function taskAgentLabel(task: Task): string | null {
  const agent = taskAgentTab(task)
  if (agent) return agent.type === 'claude-chat' ? CLAUDE_CHAT_LABEL : AI_TAB_META[agent.type as AiTabType]?.label ?? null
  const tabs = taskTabs(task)
  const main = tabs.find(tab => tab.id === resolveMainTabId(tabs, task.mainTabId))
  return main?.type === 'terminal' ? 'Terminal' : null
}

export type TaskChipTone = 'attention' | 'working' | 'turn' | 'quiet'

export interface TaskChip {
  label: string
  tone: TaskChipTone
}

/**
 * The header's status chip, in the Inbox's order: Needs you (with how long it has
 * waited), a stopped landing (Conflicts / Blocked), Working (Fixing conflicts
 * while the agent resolves a landing's), a running landing, then Snoozed /
 * Done for now, then Your turn; nothing for a quiet task.
 */
export function taskStatusChip(
  task: Task,
  allStatuses: Record<string, TabStatusValue>,
  statusSince: Record<string, number>,
  now: number
): TaskChip | null {
  const status = taskStatus(task, allStatuses)
  if (status === 'attention') {
    const since = taskStatusSince(task, allStatuses, statusSince)
    return { label: since === null ? 'Needs you' : `Needs you · ${formatWaitTime(now - since)}`, tone: 'attention' }
  }
  const landing = task.landing?.state
  if (landing === 'conflict') return { label: 'Conflicts', tone: 'attention' }
  if (landing === 'blocked') return { label: 'Blocked', tone: 'attention' }
  if (landing === 'fixing') return { label: 'Fixing conflicts', tone: 'working' }
  if (status === 'working') return { label: 'Working', tone: 'working' }
  if (landing === 'landing') return { label: task.landing?.intent === 'update' ? 'Updating…' : 'Landing…', tone: 'working' }
  if (isSnoozed(task, now)) return { label: 'Snoozed', tone: 'quiet' }
  if (isSettled(task)) return { label: 'Done for now', tone: 'quiet' }
  if (isYourTurn(task, status)) return { label: 'Your turn', tone: 'turn' }
  return null
}

/**
 * Pure helpers behind the Project map's counts: open tasks, how many need you
 * or work, and agents. Task status comes from `taskStatusChip`, so the map,
 * the task header and the Inbox agree on what a task is doing.
 */
import type { Project, TabStatusValue } from '../../shared/types'
import { projectTasks } from '../../shared/streams'
import { taskAgentLabel, taskStatusChip } from './taskHeaderState'

/** The order the Agents card lists agents in; any other label follows, by count. */
const AGENT_ORDER = ['Claude', 'Claude Code', 'Codex', 'Pi', 'Terminal']

export interface ProjectHomeSummary {
  /** Every task in the project's streams (archived ones live in Done). */
  openTasks: number
  needsYou: number
  working: number
  /** Open tasks by agent; tasks with neither an agent nor a terminal are left out. */
  agents: { label: string; count: number }[]
}

export function projectHomeSummary(
  project: Project,
  allStatuses: Record<string, TabStatusValue>,
  statusSince: Record<string, number>,
  now: number
): ProjectHomeSummary {
  const tasks = projectTasks(project)
  let needsYou = 0
  let working = 0
  const byAgent = new Map<string, number>()
  for (const task of tasks) {
    const tone = taskStatusChip(task, allStatuses, statusSince, now)?.tone
    if (tone === 'attention') needsYou += 1
    else if (tone === 'working') working += 1
    const label = taskAgentLabel(task)
    if (label) byAgent.set(label, (byAgent.get(label) ?? 0) + 1)
  }
  const rank = (label: string): number => {
    const index = AGENT_ORDER.indexOf(label)
    return index === -1 ? AGENT_ORDER.length : index
  }
  const agents = [...byAgent.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => rank(a.label) - rank(b.label) || b.count - a.count)
  return { openTasks: tasks.length, needsYou, working, agents }
}

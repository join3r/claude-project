import type { Project, Tab } from '../shared/types'
import { findTaskInProject, taskTabs } from '../shared/streams'

export interface RecentlyClosedTab {
  projectId: string
  taskId: string
  /** The column it was in, as an index into the task's pane row. */
  pane: number
  index: number
  tab: Tab
}

export function pushRecentlyClosedTab(
  history: RecentlyClosedTab[],
  entry: RecentlyClosedTab,
  limit = 10
): { history: RecentlyClosedTab[]; evicted: RecentlyClosedTab[] } {
  const next = [entry, ...history]
  return {
    history: next.slice(0, limit),
    evicted: next.slice(limit)
  }
}

export function shiftRestorableClosedTab(
  history: RecentlyClosedTab[],
  projects: Project[]
): { entry: RecentlyClosedTab | null; history: RecentlyClosedTab[]; stale: RecentlyClosedTab[] } {
  const remaining: RecentlyClosedTab[] = []
  const stale: RecentlyClosedTab[] = []
  let entry: RecentlyClosedTab | null = null

  for (const candidate of history) {
    if (entry) {
      remaining.push(candidate)
      continue
    }

    const project = projects.find((item) => item.id === candidate.projectId)
    const task = findTaskInProject(project, candidate.taskId)
    const tabExists = task
      ? taskTabs(task).some((tab) => tab.id === candidate.tab.id)
      : false

    if (!project || !task || tabExists) {
      stale.push(candidate)
      continue
    }

    entry = candidate
  }

  return { entry, history: remaining, stale }
}

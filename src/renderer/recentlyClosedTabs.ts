import type { Project, Tab } from '../shared/types'

export interface RecentlyClosedTab {
  projectId: string
  taskId: string
  pane: 'left' | 'right'
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
    const task = project?.tasks.find((item) => item.id === candidate.taskId)
    const tabExists = task
      ? [...task.tabs.left, ...task.tabs.right].some((tab) => tab.id === candidate.tab.id)
      : false

    if (!project || !task || tabExists) {
      stale.push(candidate)
      continue
    }

    entry = candidate
  }

  return { entry, history: remaining, stale }
}

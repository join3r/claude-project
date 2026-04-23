import type { AppConfig, Task } from '../../shared/types'

export const MAX_OPACITY = 0.35

export type RecencySettings = AppConfig['taskRecencyHighlight']

export function sortTasksByRecency(tasks: Task[]): Task[] {
  return tasks
    .filter((task): task is Task & { lastFocusedAt: number } => typeof task.lastFocusedAt === 'number')
    .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)
}

export function computeTaskRecencyOpacity(
  task: Task,
  sortedByRecency: Task[],
  settings: RecencySettings,
  now: number
): number {
  if (!settings.enabled) return 0
  if (typeof task.lastFocusedAt !== 'number') return 0

  if (settings.mode === 'rank') {
    const index = sortedByRecency.findIndex(t => t.id === task.id)
    if (index < 0 || index >= settings.rankCount) return 0
    return MAX_OPACITY * (1 - index / settings.rankCount)
  }

  const windowMs = settings.timeWindowMinutes * 60_000
  if (windowMs <= 0) return 0
  const age = now - task.lastFocusedAt
  if (age >= windowMs) return 0
  const remaining = 1 - age / windowMs
  return MAX_OPACITY * Math.max(0, remaining)
}

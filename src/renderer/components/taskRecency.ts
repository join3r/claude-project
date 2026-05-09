import type { CSSProperties } from 'react'
import type { AppConfig, Task } from '../../shared/types'

export const MAX_OPACITY = 0.12

const RECENCY_RGB_DARK = '100, 150, 230'
const RECENCY_RGB_LIGHT = '100, 150, 230'

export function buildRecencyStyle(opacity: number, theme: 'dark' | 'light'): CSSProperties | undefined {
  if (opacity <= 0) return undefined
  const rgb = theme === 'light' ? RECENCY_RGB_LIGHT : RECENCY_RGB_DARK
  return {
    backgroundColor: `rgba(${rgb}, ${opacity.toFixed(3)})`
  }
}

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
  if (!settings || !settings.enabled) return 0
  if (typeof task.lastFocusedAt !== 'number') return 0

  if (settings.mode === 'rank') {
    const rankCount = typeof settings.rankCount === 'number' && settings.rankCount > 0 ? settings.rankCount : 5
    const index = sortedByRecency.findIndex(t => t.id === task.id)
    if (index < 0 || index >= rankCount) return 0
    return MAX_OPACITY * (1 - index / rankCount)
  }

  const minutes = typeof settings.timeWindowMinutes === 'number' && settings.timeWindowMinutes > 0 ? settings.timeWindowMinutes : 1440
  const windowMs = minutes * 60_000
  const age = now - task.lastFocusedAt
  if (age >= windowMs) return 0
  const remaining = 1 - age / windowMs
  return MAX_OPACITY * Math.max(0, remaining)
}

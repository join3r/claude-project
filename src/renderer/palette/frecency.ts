// src/renderer/palette/frecency.ts
export interface FrecencyEntry {
  lastUsedAt: number
  useCount: number
}
export type FrecencyState = Record<string, FrecencyEntry>

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

export function computeFrecencyMultiplier(entry: FrecencyEntry | undefined, now: number): number {
  if (!entry) return 1
  const age = Math.max(0, now - entry.lastUsedAt)
  const decay = Math.pow(0.5, age / HALF_LIFE_MS)
  return 1 + Math.log(entry.useCount + 1) * decay
}

export function recordUse(state: FrecencyState, id: string, now: number): FrecencyState {
  const prev = state[id]
  const next: FrecencyEntry = prev
    ? { lastUsedAt: now, useCount: prev.useCount + 1 }
    : { lastUsedAt: now, useCount: 1 }
  return { ...state, [id]: next }
}

export function recentIds(state: FrecencyState, limit: number): string[] {
  return Object.keys(state)
    .sort((a, b) => state[b].lastUsedAt - state[a].lastUsedAt)
    .slice(0, limit)
}

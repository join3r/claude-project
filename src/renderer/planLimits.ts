import { useSyncExternalStore } from 'react'
import type { PlanAccount } from '../shared/plan-limits'

/**
 * Claude plan windows per claude.ai login, as main reports them (`plan-limits-get`
 * and the `plan-limits-changed` push): this Mac's, its SSH boxes' and its
 * servers'. Shared by every component of a window (the status bar).
 */

let accounts: PlanAccount[] = []
let started = false
const listeners = new Set<() => void>()

function set(next: PlanAccount[] | undefined): void {
  // A stubbed api (tests) may answer nothing.
  if (!Array.isArray(next)) return
  accounts = next
  for (const listener of [...listeners]) listener()
}

function ensureStarted(): void {
  if (started || typeof window === 'undefined') return
  started = true
  const api = window.api as Partial<typeof window.api> | undefined
  api?.onPlanLimitsChanged?.(set)
  void api?.planLimitsGet?.().then(set).catch(() => {})
}

function getPlanLimits(): PlanAccount[] {
  ensureStarted()
  return accounts
}

function subscribePlanLimits(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePlanLimits(): PlanAccount[] {
  return useSyncExternalStore(subscribePlanLimits, getPlanLimits)
}

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { TokenUsageReport } from '../../shared/token-usage'

/** One project's usage as this window last heard it. `report` null: its sessions aren't readable (SSH, shell command, an older server). */
export interface ProjectTokenUsage {
  report: TokenUsageReport | null
  loading: boolean
}

/** How often an open view asks again (main reads only what the agents appended since). */
const POLL_MS = 60_000

const entries = new Map<string, ProjectTokenUsage>()
const inFlight = new Set<string>()
const listeners = new Set<() => void>()
/** What the hook reads: a new map on every change. */
let snapshot: ReadonlyMap<string, ProjectTokenUsage> = new Map()

function changed(): void {
  snapshot = new Map(entries)
  for (const listener of listeners) listener()
}

function fetchUsage(projectId: string): void {
  if (inFlight.has(projectId)) return
  inFlight.add(projectId)
  const before = entries.get(projectId)
  if (!before) {
    entries.set(projectId, { report: null, loading: true })
    changed()
  }
  window.api.tokenUsageProject(projectId)
    .then(report => entries.set(projectId, { report, loading: false }))
    // A server without this channel yet, or one offline: keep what was there.
    .catch(() => entries.set(projectId, { report: entries.get(projectId)?.report ?? null, loading: false }))
    .finally(() => {
      inFlight.delete(projectId)
      changed()
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Each project's token usage, fetched now, on focus and every minute while a caller is mounted. */
export function useTokenUsage(projectIds: readonly string[]): Record<string, ProjectTokenUsage> {
  const key = projectIds.join('\n')
  useEffect(() => {
    const ids = key ? key.split('\n') : []
    const fetchAll = (): void => ids.forEach(fetchUsage)
    fetchAll()
    const timer = window.setInterval(fetchAll, POLL_MS)
    window.addEventListener('focus', fetchAll)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', fetchAll)
    }
  }, [key])
  const current = useSyncExternalStore(subscribe, () => snapshot)
  return useMemo(() => {
    const out: Record<string, ProjectTokenUsage> = {}
    for (const id of key ? key.split('\n') : []) out[id] = current.get(id) ?? { report: null, loading: true }
    return out
  }, [key, current])
}

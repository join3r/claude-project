import React, { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react'
import { logStatusTransition } from '../statusDebug'
import type { HostTabStatus, TabStatusValue } from '../../shared/types'

// Re-exported so the many `from '../context/TabStatusContext'` importers keep
// working now that main needs the same type (see shared/types.ts).
export type { TabStatusValue }

export interface TabStatusStore {
  getStatus(tabId: string): TabStatusValue
  /** `reason` is trace-only (see statusDebug) — every writer should pass one. */
  setStatus(tabId: string, status: TabStatusValue, reason?: string): void
  removeTab(tabId: string): void
  /**
   * Also publish this tab's status to main, for tabs no hook reports on (Codex,
   * shells): main — and the phone behind it — cannot see PTY output heuristics.
   * Returns the unregister function.
   */
  mirrorToMain(tabId: string): () => void
  subscribe(callback: () => void): () => void
  getSnapshot(): Record<string, TabStatusValue>
  /** When each tab's current status began — drives the inbox's "waiting 4m". */
  getSinceSnapshot(): Record<string, number>
  /** Start mirroring main's statuses (`tab-host-status`). */
  connectHost(): void
}

function createTabStatusStore(): TabStatusStore {
  // This window's own verdicts, for the tabs it mounts.
  const own: Record<string, TabStatusValue> = {}
  const ownSince: Record<string, number> = {}
  // Main's, for every tab it knows (`tab-host-status`). A tab this window never set
  // a status for shows main's: a task the prompt queue or a phone started, or one
  // mounted only in another window, would otherwise sit in the inbox as Ready.
  const host: Record<string, HostTabStatus> = {}
  let statuses: Record<string, TabStatusValue> = {}
  let since: Record<string, number> = {}
  const listeners = new Set<() => void>()
  const mirrored = new Set<string>()

  function report(tabId: string, status: TabStatusValue) {
    // Test windows stub `window.api` piecemeal; a missing channel is not an error.
    void window.api?.reportTabStatus?.(tabId, status)?.catch(() => {})
  }

  function notify() {
    statuses = {}
    since = {}
    for (const [tabId, entry] of Object.entries(host)) {
      statuses[tabId] = entry.status
      if (entry.since !== null) since[tabId] = entry.since
    }
    Object.assign(statuses, own)
    for (const tabId of Object.keys(own)) {
      if (tabId in ownSince) since[tabId] = ownSince[tabId]
      else delete since[tabId]
    }
    listeners.forEach((l) => l())
  }

  function connectHost() {
    // Test windows stub `window.api` piecemeal; without these the store is window-only.
    const api = window.api
    if (!api?.onTabHostStatus || !api.getTabStatuses) return
    let live = new Set<string>()
    api.onTabHostStatus((tabId, entry) => {
      live.add(tabId)
      if (entry.since === null) delete host[tabId]
      else host[tabId] = entry
      notify()
    })
    api.getTabStatuses().then((snapshot) => {
      // A live update beats the snapshot for the tabs it touched.
      for (const [tabId, entry] of Object.entries(snapshot)) {
        if (!live.has(tabId)) host[tabId] = entry
      }
      live = new Set()
      notify()
    }).catch(() => {})
  }

  return {
    getStatus(tabId: string) {
      return statuses[tabId] ?? null
    },
    setStatus(tabId: string, status: TabStatusValue, reason?: string) {
      if (tabId in own && own[tabId] === status) return
      logStatusTransition(tabId, statuses[tabId] ?? null, status, reason)
      // Taking over from main's status keeps its start time when they agree.
      const keepSince = !(tabId in own) && statuses[tabId] === status && tabId in since
      own[tabId] = status
      ownSince[tabId] = keepSince ? since[tabId] : Date.now()
      if (mirrored.has(tabId)) report(tabId, status)
      notify()
    },
    removeTab(tabId: string) {
      if (!(tabId in own) && !(tabId in host)) return
      delete own[tabId]
      delete ownSince[tabId]
      delete host[tabId]
      notify()
    },
    mirrorToMain(tabId: string) {
      mirrored.add(tabId)
      report(tabId, statuses[tabId] ?? null)
      return () => { mirrored.delete(tabId) }
    },
    subscribe(callback: () => void) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    getSnapshot() {
      return statuses
    },
    getSinceSnapshot() {
      return since
    },
    connectHost
  }
}

const TabStatusContext = createContext<TabStatusStore | null>(null)

export function TabStatusProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const storeRef = useRef<TabStatusStore | null>(null)
  if (!storeRef.current) storeRef.current = createTabStatusStore()
  useEffect(() => storeRef.current?.connectHost(), [])
  return <TabStatusContext.Provider value={storeRef.current}>{children}</TabStatusContext.Provider>
}

export function useTabStatusStore(): TabStatusStore {
  const store = useContext(TabStatusContext)
  if (!store) throw new Error('useTabStatusStore must be used within TabStatusProvider')
  return store
}

export function useTabStatus(tabId: string): TabStatusValue {
  const store = useTabStatusStore()
  return useSyncExternalStore(
    store.subscribe,
    () => store.getStatus(tabId)
  )
}

export function useAllTabStatuses(): Record<string, TabStatusValue> {
  const store = useTabStatusStore()
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot()
  )
}

export function useAllTabStatusSince(): Record<string, number> {
  const store = useTabStatusStore()
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSinceSnapshot()
  )
}

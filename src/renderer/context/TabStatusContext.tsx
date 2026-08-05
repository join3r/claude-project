import React, { createContext, useContext, useRef, useSyncExternalStore } from 'react'
import { logStatusTransition } from '../statusDebug'
import type { TabStatusValue } from '../../shared/types'

// Re-exported so the many `from '../context/TabStatusContext'` importers keep
// working now that main needs the same type (see shared/types.ts).
export type { TabStatusValue }

export interface TabStatusStore {
  getStatus(tabId: string): TabStatusValue
  /** `reason` is trace-only (see statusDebug) — every writer should pass one. */
  setStatus(tabId: string, status: TabStatusValue, reason?: string): void
  removeTab(tabId: string): void
  subscribe(callback: () => void): () => void
  getSnapshot(): Record<string, TabStatusValue>
  /** When each tab's current status began — drives the inbox's "waiting 4m". */
  getSinceSnapshot(): Record<string, number>
}

function createTabStatusStore(): TabStatusStore {
  let statuses: Record<string, TabStatusValue> = {}
  let since: Record<string, number> = {}
  const listeners = new Set<() => void>()

  function notify() {
    statuses = { ...statuses }
    since = { ...since }
    listeners.forEach((l) => l())
  }

  return {
    getStatus(tabId: string) {
      return statuses[tabId] ?? null
    },
    setStatus(tabId: string, status: TabStatusValue, reason?: string) {
      if (statuses[tabId] === status) return
      logStatusTransition(tabId, statuses[tabId] ?? null, status, reason)
      statuses[tabId] = status
      since[tabId] = Date.now()
      notify()
    },
    removeTab(tabId: string) {
      if (!(tabId in statuses)) return
      delete statuses[tabId]
      delete since[tabId]
      notify()
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
    }
  }
}

const TabStatusContext = createContext<TabStatusStore | null>(null)

export function TabStatusProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const storeRef = useRef<TabStatusStore | null>(null)
  if (!storeRef.current) storeRef.current = createTabStatusStore()
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

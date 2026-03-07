import React, { createContext, useContext, useRef, useSyncExternalStore } from 'react'

export type TabStatusValue = 'working' | 'attention' | 'exited' | null

export interface TabStatusStore {
  getStatus(tabId: string): TabStatusValue
  setStatus(tabId: string, status: TabStatusValue): void
  removeTab(tabId: string): void
  subscribe(callback: () => void): () => void
  getSnapshot(): Record<string, TabStatusValue>
}

function createTabStatusStore(): TabStatusStore {
  let statuses: Record<string, TabStatusValue> = {}
  const listeners = new Set<() => void>()

  function notify() {
    statuses = { ...statuses }
    listeners.forEach((l) => l())
  }

  return {
    getStatus(tabId: string) {
      return statuses[tabId] ?? null
    },
    setStatus(tabId: string, status: TabStatusValue) {
      if (statuses[tabId] === status) return
      statuses[tabId] = status
      notify()
    },
    removeTab(tabId: string) {
      if (!(tabId in statuses)) return
      delete statuses[tabId]
      notify()
    },
    subscribe(callback: () => void) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    getSnapshot() {
      return statuses
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

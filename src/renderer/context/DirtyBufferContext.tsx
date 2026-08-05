import React, { createContext, useContext, useRef } from 'react'

export interface DirtyBufferEntry {
  /** Project-relative path — this is what the close prompt lists back to the user. */
  filePath: string
  isDirty: boolean
  /**
   * Write the buffer to disk. Rejects when the write fails, so a caller that is
   * about to throw the buffer away can stop instead.
   */
  save: () => Promise<void>
}

export interface DirtyBuffer extends DirtyBufferEntry {
  tabId: string
}

export interface DirtyBufferStore {
  /**
   * Publish a tab's buffer state. Returns a token that identifies *this*
   * registration; hand it back to `unregisterBuffer` so a remounting editor
   * cannot delete the entry its successor just wrote.
   */
  registerBuffer(tabId: string, buffer: DirtyBufferEntry): number
  /** Without a token this drops whatever is registered for the tab. */
  unregisterBuffer(tabId: string, token?: number): void
  /** Dirty buffers, optionally narrowed to the tabs a removal is about to take. */
  getDirtyTabs(tabIds?: string[]): DirtyBuffer[]
  /**
   * Fires whenever the registry changes. `useAppState` uses it to publish this
   * window's unsaved tabs to main, which has no other way to know an automatic
   * deletion would be throwing a buffer away.
   */
  subscribe(listener: () => void): () => void
}

interface StoredBuffer extends DirtyBuffer {
  token: number
}

export function createDirtyBufferStore(): DirtyBufferStore {
  const buffers = new Map<string, StoredBuffer>()
  const listeners = new Set<() => void>()
  let nextToken = 0

  function notify(): void {
    for (const listener of listeners) listener()
  }

  return {
    registerBuffer(tabId: string, buffer: DirtyBufferEntry) {
      nextToken += 1
      buffers.set(tabId, { ...buffer, tabId, token: nextToken })
      notify()
      return nextToken
    },
    unregisterBuffer(tabId: string, token?: number) {
      const stored = buffers.get(tabId)
      if (!stored) return
      if (token !== undefined && stored.token !== token) return
      buffers.delete(tabId)
      notify()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getDirtyTabs(tabIds?: string[]) {
      const scope = tabIds ? new Set(tabIds) : null
      const dirty: DirtyBuffer[] = []
      for (const stored of buffers.values()) {
        if (!stored.isDirty) continue
        if (scope && !scope.has(stored.tabId)) continue
        const { tabId, filePath, isDirty, save } = stored
        dirty.push({ tabId, filePath, isDirty, save })
      }
      return dirty
    }
  }
}

// Unlike TabStatusContext this has a default store rather than throwing when no
// provider is mounted: the registry is read from `useAppState`, which runs in
// the provider *above* every component that could host one. A renderer is a
// single window, so one registry per module is the right scope; the provider
// exists so tests (and any future multi-root render) can get an isolated one.
const defaultStore = createDirtyBufferStore()

const DirtyBufferContext = createContext<DirtyBufferStore>(defaultStore)

export function DirtyBufferProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const storeRef = useRef<DirtyBufferStore | null>(null)
  if (!storeRef.current) storeRef.current = createDirtyBufferStore()
  return <DirtyBufferContext.Provider value={storeRef.current}>{children}</DirtyBufferContext.Provider>
}

export function useDirtyBufferStore(): DirtyBufferStore {
  return useContext(DirtyBufferContext)
}

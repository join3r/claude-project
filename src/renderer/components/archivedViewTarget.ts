import { useSyncExternalStore } from 'react'

/**
 * The archived task or stream this window shows read-only in the content area,
 * in place of the project's Home page. Opened from a Done row; anything that
 * selects a task or Home again closes it. Not persisted.
 */
export interface ArchivedViewTarget {
  projectId: string
  kind: 'task' | 'stream'
  id: string
}

let current: ArchivedViewTarget | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function openArchivedView(target: ArchivedViewTarget): void {
  current = target
  emit()
}

export function closeArchivedView(): void {
  if (!current) return
  current = null
  emit()
}

export function getArchivedView(): ArchivedViewTarget | null {
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useArchivedView(): ArchivedViewTarget | null {
  return useSyncExternalStore(subscribe, getArchivedView)
}

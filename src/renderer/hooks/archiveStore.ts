import { useEffect, useSyncExternalStore } from 'react'
import type { ProjectArchive } from '../../shared/archive'

/**
 * This window's copy of the project archives it has opened (a Done row
 * expanded, an archived item shown). Read lazily from main, kept until main
 * says the file changed (`archive-changed`, from any window or a phone), then
 * read again if anything here still shows it.
 */

interface Entry {
  archive: ProjectArchive | null
  loading: Promise<ProjectArchive> | null
  /** Bumped on every change, so a stale read never overwrites a newer one. */
  generation: number
  users: number
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let listening = false
/** Called with every archive read off disk (the counts in the data follow it). */
let onLoaded: ((projectId: string, archive: ProjectArchive) => void) | null = null

function entryFor(projectId: string): Entry {
  let entry = entries.get(projectId)
  if (!entry) {
    entry = { archive: null, loading: null, generation: 0, users: 0 }
    entries.set(projectId, entry)
  }
  return entry
}

function notify(): void {
  for (const listener of listeners) listener()
}

function ensureListening(): void {
  if (listening || typeof window === 'undefined' || !window.api?.onArchiveChanged) return
  listening = true
  window.api.onArchiveChanged((projectId) => {
    const entry = entries.get(projectId)
    if (!entry) return
    entry.generation += 1
    entry.loading = null
    if (entry.users > 0) void loadArchive(projectId)
  })
}

/** Register what to do with an archive once read (sync the Done counts). */
export function setArchiveLoadedHandler(handler: ((projectId: string, archive: ProjectArchive) => void) | null): void {
  onLoaded = handler
}

/** The project's archive, read from main once and then from this window's copy. */
export function loadArchive(projectId: string): Promise<ProjectArchive> {
  ensureListening()
  const entry = entryFor(projectId)
  if (entry.loading) return entry.loading
  const generation = entry.generation
  const loading = window.api.archiveLoad(projectId).then((archive) => {
    if (entry.generation === generation) {
      entry.archive = archive
      notify()
      onLoaded?.(projectId, archive)
    }
    return archive
  })
  entry.loading = loading
  loading.catch(() => { if (entry.loading === loading) entry.loading = null })
  return loading
}

/** Adopt the archive a change handed back (newer than anything read before). */
export function adoptArchive(projectId: string, archive: ProjectArchive): void {
  const entry = entryFor(projectId)
  entry.generation += 1
  entry.archive = archive
  entry.loading = Promise.resolve(archive)
  notify()
}

export function peekArchive(projectId: string): ProjectArchive | null {
  return entries.get(projectId)?.archive ?? null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The archive of `projectId` while `enabled` (null until read). Reading starts
 * when the first user enables it.
 */
export function useProjectArchive(projectId: string | null, enabled: boolean): ProjectArchive | null {
  const archive = useSyncExternalStore(subscribe, () => (projectId && enabled ? peekArchive(projectId) : null))
  useEffect(() => {
    if (!projectId || !enabled) return
    const entry = entryFor(projectId)
    entry.users += 1
    void loadArchive(projectId).catch(() => {})
    return () => { entry.users -= 1 }
  }, [projectId, enabled])
  return archive
}

/** Tests only. */
export function resetArchiveStore(): void {
  entries.clear()
  listeners.clear()
  listening = false
  onLoaded = null
}

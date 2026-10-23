import { useSyncExternalStore } from 'react'
import type { PendingWorktreeSetup, Project } from '../shared/types'

/**
 * The window's one place for the dialogs a project or stream menu opens, so
 * those menus work wherever they are shown (the tree, the Inbox, the task
 * header, Project Home), with the sidebar on the Inbox tab or hidden.
 * `EntityActionsHost` (mounted by App) draws them.
 */
export type EntityDialog =
  | { kind: 'project-settings'; projectId: string }
  /** Rename… for a project with a folder: the dialog that can rename the folder too. */
  | { kind: 'rename-project'; projectId: string }
  /** A plain name: a stream, or a project without a folder. */
  | { kind: 'rename'; projectId: string; streamId?: string }
  | { kind: 'duplicate-project'; projectId: string }
  /** The SSH project as it was when the dialog opened (once moved it has no `ssh`). */
  | { kind: 'move-to-server'; project: Project }
  /** A stream's worktree setup commands waiting for approval (a new or reopened stream). */
  | { kind: 'stream-setup'; projectId: string; streamId: string; branch: string; pending: PendingWorktreeSetup }

let dialog: EntityDialog | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

export function openEntityDialog(next: EntityDialog): void {
  dialog = next
  notify()
}

export function getEntityDialog(): EntityDialog | null {
  return dialog
}

export function closeEntityDialog(): void {
  dialog = null
  notify()
}

export function useEntityDialog(): EntityDialog | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => dialog
  )
}

// ---- requests the host carries out ------------------------------------------

type CloseStreamListener = (projectId: string, streamId: string) => void
const closeStreamListeners = new Set<CloseStreamListener>()

/** Close a stream through the host's close flow (its questions show as dialogs there). */
export function requestCloseStream(projectId: string, streamId: string): void {
  closeStreamListeners.forEach((listener) => listener(projectId, streamId))
}

export function onCloseStreamRequest(listener: CloseStreamListener): () => void {
  closeStreamListeners.add(listener)
  return () => { closeStreamListeners.delete(listener) }
}

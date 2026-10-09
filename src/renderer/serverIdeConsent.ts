import { useSyncExternalStore } from 'react'
import type { ServerIdeState } from '../shared/server-ide'

/**
 * Open in IDE's first-use question for a DevTool server (plan step 9), asked
 * from wherever Open in IDE was used (toolbar, palette, file tree) and shown by
 * the one ServerIdeConsentModal the window mounts.
 */

interface Pending {
  state: ServerIdeState
  resolve: (agreed: boolean) => void
}

let pending: Pending | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Shows the question; resolves true when the user agrees. A second ask replaces (declines) the first. */
export function askServerIdeConsent(state: ServerIdeState): Promise<boolean> {
  pending?.resolve(false)
  return new Promise((resolve) => {
    pending = { state, resolve }
    notify()
  })
}

/** The modal's answer. */
export function answerServerIdeConsent(agreed: boolean): void {
  const current = pending
  pending = null
  current?.resolve(agreed)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePendingServerIdeConsent(): ServerIdeState | null {
  return useSyncExternalStore(subscribe, () => pending?.state ?? null)
}

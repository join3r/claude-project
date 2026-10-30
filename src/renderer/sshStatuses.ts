import { useEffect, useSyncExternalStore } from 'react'

/**
 * The SSH masters' states as main reports them (`ssh-status` and the
 * `ssh-status-changed` push), by project id, for the desk's status bar. Each
 * project is asked once; pushes keep it current.
 */

let statuses: Readonly<Record<string, string>> = {}
let connected = false
const asked = new Set<string>()
const listeners = new Set<() => void>()

function set(projectId: string, status: string): void {
  if (statuses[projectId] === status) return
  statuses = { ...statuses, [projectId]: status }
  for (const listener of [...listeners]) listener()
}

function connect(): void {
  if (connected) return
  connected = true
  // The preload's listener can't be removed: one per window, for its lifetime.
  window.api.onSshStatusChanged(set)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The SSH states of these projects (and any other this window heard of). */
export function useSshStatuses(projectIds: readonly string[]): Readonly<Record<string, string>> {
  const key = projectIds.join('\u0000')
  useEffect(() => {
    connect()
    for (const projectId of key ? key.split('\u0000') : []) {
      if (asked.has(projectId)) continue
      asked.add(projectId)
      window.api.sshStatus(projectId).then(status => set(projectId, status)).catch(() => { asked.delete(projectId) })
    }
  }, [key])
  return useSyncExternalStore(subscribe, () => statuses)
}

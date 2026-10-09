import { useSyncExternalStore } from 'react'
import type { ServerConnectionKind, ServersState, ServerStatus } from '../shared/servers'

/**
 * The paired DevTool servers as main reports them (`servers-get-state` and the
 * `servers-state-changed` push), shared by every component of a window: the
 * sidebar's server badge, the terminals' offline overlay, the projects sync.
 */

let state: ServersState = { relay: { kind: 'idle' }, servers: [], invite: null }
let started = false
const listeners = new Set<() => void>()

function set(next: ServersState | undefined): void {
  // A stubbed api (tests) may answer nothing.
  if (!next || !Array.isArray(next.servers)) return
  state = next
  for (const listener of [...listeners]) listener()
}

function ensureStarted(): void {
  if (started || typeof window === 'undefined') return
  started = true
  // Test windows stub `window.api` piecemeal; no servers then.
  const api = window.api as Partial<typeof window.api> | undefined
  api?.onServersStateChanged?.(set)
  void api?.serversGetState?.().then(set).catch(() => {})
}

export function getServersState(): ServersState {
  ensureStarted()
  return state
}

export function subscribeServersState(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useServersState(): ServersState {
  return useSyncExternalStore(subscribeServersState, getServersState)
}

/** One server's status; null for no server (a local project) or one this desktop doesn't know. */
export function useServerStatus(serverId: string | undefined): ServerStatus | null {
  const current = useServersState()
  return serverId ? current.servers.find(s => s.id === serverId) ?? null : null
}

/** What a server's projects look like right now: `online`, or anything else (greyed out). */
export function serverConnection(serverId: string, current: ServersState = getServersState()): ServerConnectionKind {
  return current.servers.find(s => s.id === serverId)?.state ?? 'offline'
}

/** The server's display name, or a short form of its id while it isn't known. */
export function serverName(serverId: string, current: ServersState = getServersState()): string {
  return current.servers.find(s => s.id === serverId)?.name || `server ${serverId.slice(0, 6)}`
}

/** Tests: start over. */
export function resetServersStateForTests(next?: ServersState): void {
  started = !!next
  state = next ?? { relay: { kind: 'idle' }, servers: [], invite: null }
  for (const listener of [...listeners]) listener()
}

import { getServersState, useServersState } from './serversState'
import type { ServersState } from '../shared/servers'

/** The OS this window runs on: preload's `window.api.platform`, else Node's (tests). */
export function desktopPlatform(): string {
  if (typeof window !== 'undefined') {
    const platform = (window.api as Partial<typeof window.api> | undefined)?.platform
    if (platform) return platform
  }
  if (typeof process !== 'undefined' && process.platform) return process.platform
  return 'darwin'
}

/**
 * The OS a project's processes run on (plan step 7): its DevTool server's, as
 * the server said in its handshake, else this desktop's. A server that never
 * said is Linux for these purposes: servers run on Linux or macOS, never
 * Windows, so anything that only differs on Windows behaves as on Unix.
 */
export function hostPlatform(serverId: string | undefined, state: ServersState = getServersState()): string {
  if (!serverId) return desktopPlatform()
  return state.servers.find(s => s.id === serverId)?.host?.os || 'linux'
}

/** {@link hostPlatform}, following the servers state. */
export function useHostPlatform(serverId: string | undefined): string {
  const state = useServersState()
  return hostPlatform(serverId, state)
}

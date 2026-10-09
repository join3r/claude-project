import React from 'react'
import { serverName, useServersState } from '../serversState'

/** Whether a tab of this project can reach its host: always for this desktop's projects. */
export function useServerOnline(serverId: string | undefined): boolean {
  const state = useServersState()
  if (!serverId) return true
  return state.servers.find(s => s.id === serverId)?.state === 'online'
}

/**
 * Over a terminal or agent tab of a DevTool server's project while the server
 * can't be reached: the last screen stays readable underneath, and the tab
 * attaches again (with its scrollback) once the server is back.
 */
export default function ServerOfflineOverlay({ serverId }: { serverId: string }): React.ReactElement | null {
  const state = useServersState()
  const status = state.servers.find(s => s.id === serverId)
  if (status?.state === 'online') return null
  const name = serverName(serverId, state)
  const message = status?.state === 'incompatible'
    ? `${name} can't connect: ${status.error ?? 'update needed'}`
    : status?.state === 'connecting'
      ? `Reconnecting to ${name}…`
      : `${name} is offline, reconnecting…`
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg/60" data-testid="server-offline-overlay">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-surface-2 text-sm text-text-muted shadow-lg">
        <span className="w-1.5 h-1.5 rounded-full bg-status-exited shrink-0" aria-hidden />
        <span>{message}</span>
      </div>
    </div>
  )
}

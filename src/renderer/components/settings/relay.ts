import type { MobileState } from '../../../shared/mobile'
import type { ServersState } from '../../../shared/servers'
import { RELAY_TOO_OLD_FOR_SERVERS } from '../../../shared/servers'

/**
 * The relay socket is one, shared by Mobile and the servers (main's RelayMux),
 * so its status is whichever of them knows more.
 */
export type RelayTone = 'online' | 'connecting' | 'offline' | 'warn' | 'idle'

export function relayStatus(mobile: MobileState | null, servers: ServersState): { tone: RelayTone; text: string } {
  const mobileKind = mobile?.connection.kind ?? 'disabled'
  const serversKind = servers.relay.kind
  if (serversKind === 'too-old') return { tone: 'warn', text: `Connected. ${RELAY_TOO_OLD_FOR_SERVERS}.` }
  if (mobileKind === 'online' || serversKind === 'online') return { tone: 'online', text: 'Connected' }
  if (mobileKind === 'connecting' || serversKind === 'connecting') return { tone: 'connecting', text: 'Connecting…' }
  if (mobileKind === 'offline' || serversKind === 'offline') {
    const error = (mobile?.connection.kind === 'offline' ? mobile.connection.error : undefined) ?? servers.relay.error
    return { tone: 'offline', text: error ? `Offline: ${error}` : 'Offline' }
  }
  return { tone: 'idle', text: 'Not in use. DevTool connects once Mobile is on or a server is paired.' }
}

export const RELAY_DOT: Record<RelayTone, string> = {
  online: 'bg-ssh-connected',
  connecting: 'bg-ssh-connecting status-pulse',
  offline: 'bg-ssh-disconnected',
  warn: 'bg-warn',
  idle: 'bg-status-exited'
}

/** "2 servers and 1 phone", or null when nothing is paired. */
export function pairedOnRelay(serverCount: number, phoneCount: number): string | null {
  const parts: string[] = []
  if (serverCount > 0) parts.push(serverCount === 1 ? '1 server' : `${serverCount} servers`)
  if (phoneCount > 0) parts.push(phoneCount === 1 ? '1 phone' : `${phoneCount} phones`)
  return parts.length > 0 ? parts.join(' and ') : null
}

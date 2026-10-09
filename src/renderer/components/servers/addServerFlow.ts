import type { ServerHostInfo, ServerStatus, ServersState } from '../../../shared/servers'

/**
 * Add server's progress, worked out from main's servers state. The dialog shows
 * one status line and a four-step rail: run the command, connect, install, done.
 *
 * What main reports along the way (token flow): the invite is `waiting`; the
 * installer pairs and the invite turns `paired` with the new server's id; the
 * server connects (`connecting`, then `online` with `installing`), takes the
 * bundle (`upload`), and the installer leaves (`offline`, still `installing`)
 * while it sets up the service; the service connects (`online`, no
 * `installing`). A code pairing joins the same path at "connect".
 */

export type InstallPhase =
  | 'relay-connecting'
  | 'relay-offline'
  | 'relay-too-old'
  | 'waiting'
  | 'expired'
  | 'lost'
  | 'connecting'
  | 'installing'
  | 'starting'
  | 'connected'
  | 'incompatible'
  | 'refused'

export interface InstallProgress {
  phase: InstallPhase
  /** 0 run the command, 1 connect, 2 install, 3 done. */
  step: 0 | 1 | 2 | 3
  /** The server once one paired. */
  server: ServerStatus | null
  /** 0..1 while the bundle uploads. */
  fraction?: number
}

/** How long a phase may sit still before the dialog points at the server's terminal. */
export const STALL_MS = 120_000

export interface ProgressInput {
  state: ServersState
  /** The server this dialog paired, once it did. */
  serverId: string | null
  /** The command this dialog last showed: when it lapses. Null before the first one. */
  inviteExpiresAt: number | null
  now: number
}

export function installProgress({ state, serverId, inviteExpiresAt, now }: ProgressInput): InstallProgress {
  const server = serverId ? state.servers.find((s) => s.id === serverId) ?? null : null
  if (server) return serverProgress(server)
  if (serverId) {
    // Paired a moment ago and not in the list yet: the next state brings it.
    return { phase: 'connecting', step: 1, server: null }
  }
  const invite = state.invite
  const live = invite && invite.status === 'waiting' && invite.expiresAt > now
  if (!live) {
    if (inviteExpiresAt !== null && inviteExpiresAt > now && !invite) return { phase: 'lost', step: 0, server: null }
    if (inviteExpiresAt !== null) return { phase: 'expired', step: 0, server: null }
  }
  switch (state.relay.kind) {
    case 'too-old': return { phase: 'relay-too-old', step: 0, server: null }
    case 'offline': return { phase: 'relay-offline', step: 0, server: null }
    case 'connecting':
    case 'idle': return { phase: 'relay-connecting', step: 0, server: null }
    default: return { phase: 'waiting', step: 0, server: null }
  }
}

function serverProgress(server: ServerStatus): InstallProgress {
  if (server.state === 'incompatible') return { phase: 'incompatible', step: 1, server }
  if (server.problem === 'revoked' || server.problem === 'unknown-device' || server.problem === 'relay-too-old') return { phase: 'refused', step: 1, server }
  if (server.state === 'online' && !server.installing) return { phase: 'connected', step: 3, server }
  if (server.state === 'online' && server.installing) {
    const fraction = server.upload && server.upload.total > 0 ? Math.min(1, server.upload.sent / server.upload.total) : undefined
    return { phase: 'installing', step: 2, server, ...(fraction !== undefined ? { fraction } : {}) }
  }
  if (server.installing || server.state === 'updating') return { phase: 'starting', step: 2, server }
  return { phase: 'connecting', step: 1, server }
}

/**
 * The server this dialog's invite paired with. It sticks: the invite lapses 15
 * minutes after it was made, paired or not, and the dialog keeps following the
 * server after that.
 */
export function pairedServerId(previous: string | null, state: ServersState): string | null {
  if (previous) return previous
  return state.invite?.status === 'paired' && state.invite.serverId ? state.invite.serverId : null
}

/** Phases worth a "check the server's terminal" note once they last {@link STALL_MS}. */
export function canStall(phase: InstallPhase): boolean {
  return phase === 'waiting' || phase === 'connecting' || phase === 'starting'
}

/** `Linux arm64`, `macOS x64`. */
export function describePlatform(host: ServerHostInfo): string {
  const os = host.os === 'darwin' ? 'macOS' : host.os === 'linux' ? 'Linux' : host.os
  return `${os} ${host.arch}`
}

/** What the status line says. `name` is the server's name in DevTool. */
export function phaseText(progress: InstallProgress, relay: { url?: string; error?: string } = {}): { title: string; detail?: string } {
  const relayUrl = relay.url
  const relayError = relay.error
  const name = progress.server?.name ?? 'the server'
  const host = progress.server?.host?.hostname || name
  switch (progress.phase) {
    case 'relay-connecting':
      return { title: 'Connecting to the relay…' }
    case 'relay-offline':
      return {
        title: "Can't reach the relay",
        detail: `${relayUrl ? `DevTool can't connect to ${relayUrl}` : "DevTool can't connect to the relay"}${relayError ? ` (${relayError})` : ''}. Check the address in Settings, Relay.`
      }
    case 'relay-too-old':
      return { title: 'This relay is too old for servers', detail: 'Update the relay, or pick another one in Settings, Relay.' }
    case 'waiting':
      return { title: 'Waiting for the server…', detail: 'The command installs DevTool in ~/.devtool-server and connects it here. Linux or macOS, x64 or arm64, no root needed.' }
    case 'expired':
      return { title: 'This command expired', detail: 'Make a new command and run that one instead.' }
    case 'lost':
      return { title: 'This command no longer works', detail: 'A phone pairing code took its place. Make a new command to add a server.' }
    case 'connecting':
      return { title: `Connecting to ${name}…` }
    case 'installing':
      return { title: progress.fraction !== undefined ? `Installing DevTool on ${name}… ${Math.round(progress.fraction * 100)}%` : `Installing DevTool on ${name}…` }
    case 'starting':
      return { title: `Starting DevTool on ${name}…`, detail: 'The installer is setting up a service so the server keeps running.' }
    case 'connected':
      return { title: `Connected to ${host}` }
    case 'incompatible':
      return {
        title: `${name} can't talk to this DevTool`,
        detail: progress.server?.update === 'desktop' ? 'Update DevTool on this computer, then try again.' : 'Run the install command on the server again to update it.'
      }
    case 'refused':
      return { title: `${name} refused the connection`, detail: progress.server?.error ?? 'Make a new command and run the installer again.' }
  }
}

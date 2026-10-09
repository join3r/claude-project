import type { ServerMatch } from '../../../shared/project-move'
import type { ServerStatus } from '../../../shared/servers'
import type { Project } from '../../../shared/types'

/** Install, or one of the paired servers. */
export type MoveChoice = { kind: 'install' } | { kind: 'server'; serverId: string }

/** The choice the dialog starts on, for what the host check found. Null while there is nothing to move to. */
export function initialChoice(match: ServerMatch | null): MoveChoice | null {
  if (!match) return null
  switch (match.kind) {
    case 'paired': return { kind: 'server', serverId: match.serverId }
    case 'install': return { kind: 'install' }
    case 'other-relay': return null
    case 'ask': return match.likely ? { kind: 'server', serverId: match.likely } : { kind: 'install' }
  }
}

/** `user@host`, as the SSH project names its machine. */
export function sshHostLabel(project: Pick<Project, 'ssh'>): string {
  const ssh = project.ssh
  if (!ssh) return ''
  return `${ssh.username ? `${ssh.username}@` : ''}${ssh.host}`
}

/**
 * What the confirm step says will happen, one line each. `server`: the paired
 * server it goes to, when that is the choice.
 */
export function moveSummary(input: {
  host: string
  choice: MoveChoice | null
  server: ServerStatus | null
  tunnel: boolean
  socks: boolean
}): string[] {
  const { host, choice, server, tunnel, socks } = input
  const lines: string[] = []
  if (choice?.kind === 'server' && server) lines.push(`It goes to ${server.name}, which already runs on ${host}. Nothing gets installed.`)
  else lines.push(`DevTool installs on ${host} if needed.`)
  lines.push('The project moves with its streams, tasks and notes.')
  lines.push('Open terminals and agent tabs restart on the server, and agents resume their sessions.')
  lines.push('The SSH project goes away.')
  if (tunnel || socks) {
    const what = tunnel && socks ? 'Its SSH tunnel and SOCKS proxy close' : tunnel ? 'Its SSH tunnel closes' : 'Its SOCKS proxy closes'
    lines.push(`${what}. Browser tabs reach ports on ${host} through the server instead.`)
  }
  return lines
}

/** Why the dialog asks which server runs on the host. */
export function askReason(probeError: string | null): string {
  return probeError
    ? `DevTool couldn't check the host (${probeError}). Pick the server that runs there, or install one.`
    : 'A paired server reports this machine, but DevTool found no server in ~/.devtool-server there. Pick it, or install one.'
}

/** The refusal for a server on another relay. */
export function otherRelayText(host: string, theirs: string, ours: string | undefined): string {
  return `${host} runs a DevTool server on another relay (${theirs}). This computer uses ${ours || 'a different relay'}, so it can't pair with that server. Switch the relay in Settings, Relay, or run devtool-server uninstall on ${host} first.`
}

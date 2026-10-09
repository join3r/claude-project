import type { Project } from '../../../shared/types'
import type { SshInstallTarget } from '../../../shared/servers'

/** An SSH machine this desktop already knows from its SSH projects. */
export interface KnownSshTarget {
  /** `user@host[:port]`, as the field shows it. */
  label: string
  target: SshInstallTarget
}

/** `user@host:port` (port left out when it is 22; IPv6 in brackets). */
export function formatSshTarget(target: SshInstallTarget): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host
  return `${target.user ? `${target.user}@` : ''}${host}${target.port && target.port !== 22 ? `:${target.port}` : ''}`
}

/** The SSH projects' machines, each once, in the sidebar's order. */
export function knownSshTargets(projects: readonly Project[]): KnownSshTarget[] {
  const seen = new Map<string, KnownSshTarget>()
  for (const project of projects) {
    const ssh = project.ssh
    if (!ssh?.host) continue
    const target: SshInstallTarget = {
      host: ssh.host,
      ...(ssh.username ? { user: ssh.username } : {}),
      ...(ssh.port && ssh.port !== 22 ? { port: ssh.port } : {}),
      ...(ssh.keyFile ? { keyFile: ssh.keyFile } : {})
    }
    const label = formatSshTarget(target)
    if (!seen.has(label)) seen.set(label, { label, target })
  }
  return [...seen.values()]
}

/**
 * Reads what the user typed: `host`, `user@host`, `user@host:port`,
 * `[v6]:port` or a bare IPv6 address, optionally after `ssh://`.
 */
export function parseSshTarget(text: string): { target: SshInstallTarget } | { error: string } {
  let rest = text.trim().replace(/^ssh:\/\//i, '').replace(/\/+$/, '')
  if (!rest) return { error: 'Enter the server as user@host.' }
  if (/\s/.test(rest)) return { error: 'Leave out spaces: user@host or user@host:port.' }
  let user: string | undefined
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
    if (!user) return { error: 'Put a user name before the @, or leave the @ out.' }
  }
  let host = rest
  let port: number | undefined
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest)
  if (bracketed) {
    host = bracketed[1]
    if (bracketed[2]) port = Number(bracketed[2])
  } else if ((rest.match(/:/g) ?? []).length === 1) {
    const [h, p] = rest.split(':')
    host = h
    if (!/^\d+$/.test(p)) return { error: 'The port after the colon must be a number.' }
    port = Number(p)
  }
  if (!host) return { error: 'Enter a host name after the @.' }
  if (host.startsWith('-') || !/^[A-Za-z0-9_.:%-]+$/.test(host)) return { error: 'That host name has characters ssh does not accept.' }
  if (user !== undefined && (user.startsWith('-') || !/^[A-Za-z0-9_.@-]+$/.test(user))) return { error: 'That user name has characters ssh does not accept.' }
  if (port !== undefined && (port < 1 || port > 65535)) return { error: 'The port must be between 1 and 65535.' }
  return { target: { host, ...(user ? { user } : {}), ...(port !== undefined && port !== 22 ? { port } : {}) } }
}

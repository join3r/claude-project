import fs from 'fs'
import path from 'path'
import { atomicWriteFileSync } from '../atomic-write'

/**
 * Open in IDE on a DevTool server (plan step 9), the ssh config side.
 *
 * DevTool keeps its own `<configDir>/ssh/config` with one `Host devtool-<slug>`
 * per server, whose ProxyCommand reaches the desktop's socket for that server
 * (and through it, the server's sshd). The user's `~/.ssh/config` gets a single
 * `Include` of that file at the top, so VS Code, Cursor and plain `ssh` see the
 * hosts. Both writes are idempotent; the user's file is backed up before the
 * first change.
 */

/** Marks the lines DevTool put in the user's ssh config. */
export const INCLUDE_COMMENT = '# Added by DevTool: Open in IDE on DevTool servers (Host devtool-*)'

/** A server's entry in DevTool's ssh config. */
export interface SshHostEntry {
  serverId: string
  /** `devtool-<slug>`: what VS Code's `ssh-remote+` names. */
  alias: string
  /** The server's hostname, from its handshake (cosmetic: the ProxyCommand does the connecting). */
  hostName: string
  user: string
  /** sshd's host keys (`<type> <base64>`), pinned in DevTool's known_hosts under the alias. */
  hostKeys: string[]
}

export interface SshConfigPaths {
  /** `<configDir>/ssh/id_ed25519`. */
  identityFile: string
  /** `<configDir>/ssh/known_hosts`. */
  knownHostsFile: string
}

const PLAIN_SSH_WORD = /^[A-Za-z0-9_./:@+,=~-]+$/

/** One ssh_config argument: as is when plain, else double-quoted. `%` is doubled (ssh expands tokens). */
export function sshConfigWord(value: string): string {
  if (/["\n\r\0]/.test(value)) throw new Error(`Can't put ${JSON.stringify(value)} in an ssh config`)
  const escaped = value.replace(/%/g, '%%')
  return PLAIN_SSH_WORD.test(value) ? escaped : `"${escaped}"`
}

/** One word for the shell ssh runs a ProxyCommand with. */
export function shellWord(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error(`Can't put ${JSON.stringify(value)} in a ProxyCommand`)
  const escaped = value.replace(/%/g, '%%')
  return PLAIN_SSH_WORD.test(value) ? escaped : `'${escaped.replace(/'/g, `'\\''`)}'`
}

/** `devtool-<slug>` from the server's name, unique among `taken`. */
export function aliasForServer(name: string, serverId: string, taken: Iterable<string> = []): string {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')
  const base = `devtool-${slug || serverId.slice(0, 8)}`
  const used = new Set(taken)
  if (!used.has(base)) return base
  const withId = `${base}-${serverId.slice(0, 6)}`
  if (!used.has(withId)) return withId
  return `devtool-${serverId}`
}

/** The `Host` block for one server. */
export function renderHostBlock(entry: SshHostEntry, proxyCommand: string, paths: SshConfigPaths): string {
  if (!/^devtool-[a-z0-9-]+$/.test(entry.alias)) throw new Error(`Bad ssh alias ${entry.alias}`)
  const lines = [
    `# DevTool server ${entry.serverId}`,
    `Host ${entry.alias}`,
    `  HostName ${sshConfigWord(entry.hostName || entry.alias)}`,
    ...(entry.user ? [`  User ${sshConfigWord(entry.user)}`] : []),
    `  ProxyCommand ${proxyCommand}`,
    `  IdentityFile ${sshConfigWord(paths.identityFile)}`,
    '  IdentitiesOnly yes',
    // Host keys are pinned per alias in DevTool's own known_hosts, never the user's.
    `  HostKeyAlias ${entry.alias}`,
    `  UserKnownHostsFile ${sshConfigWord(paths.knownHostsFile)}`,
    '  StrictHostKeyChecking accept-new'
  ]
  return lines.join('\n') + '\n'
}

/** DevTool's whole ssh config: a header and one block per server. */
export function renderDevtoolSshConfig(blocks: string[]): string {
  return [
    '# Written by DevTool for Open in IDE on DevTool servers. DevTool rewrites this file;',
    '# edits are lost. Each host reaches a server\'s sshd through the running DevTool.',
    '',
    ...blocks.map((block) => block)
  ].join('\n')
}

/** DevTool's known_hosts: each server's sshd keys under its alias. */
export function renderKnownHosts(entries: SshHostEntry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    for (const key of entry.hostKeys) {
      if (/^[a-z0-9-]+ [A-Za-z0-9+/]+={0,3}$/.test(key)) lines.push(`${entry.alias} ${key}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : ''
}

// ---- the user's ~/.ssh/config --------------------------------------------------------

/** The arguments of one ssh_config line (double quotes group, as ssh reads them). */
function configArgs(rest: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(rest)) !== null) out.push(match[1] ?? match[2])
  return out
}

/** Whether `content` already has an `Include` of `target` (as written, `~/`, or `$HOME/`). */
export function hasInclude(content: string, target: string, home: string): boolean {
  const forms = new Set([target])
  if (home && target.startsWith(home + '/')) {
    forms.add(`~${target.slice(home.length)}`)
    forms.add(`$HOME${target.slice(home.length)}`)
  }
  for (const raw of content.split(/\r?\n/)) {
    const match = /^\s*include(?:\s*=\s*|\s+)(.*)$/i.exec(raw)
    if (!match) continue
    if (configArgs(match[1]).some((arg) => forms.has(arg))) return true
  }
  return false
}

/** The lines DevTool puts at the top of the user's ssh config. */
export function includeLines(target: string): string {
  return `${INCLUDE_COMMENT}\nInclude ${sshConfigWord(target)}\n`
}

export interface EnsureIncludeResult {
  /** False when the Include was there already. */
  changed: boolean
  /** The copy made before changing an existing file. */
  backup?: string
  /** The user had no ssh config; DevTool created it. */
  created: boolean
}

/** `YYYYMMDD-HHMMSS` in UTC, for a backup's name. */
function stamp(now: Date): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

/**
 * Puts `Include <target>` at the top of the user's ssh config (`~/.ssh/config`),
 * once. Creates `~/.ssh` (0700) and the file (0600) when missing; otherwise
 * copies the file to `config.devtool-backup-<stamp>` first and keeps its mode.
 * A symlinked config (dotfiles) is written through the link.
 */
export function ensureUserSshInclude(userConfig: string, target: string, options: { home: string; now?: Date }): EnsureIncludeResult {
  let file = userConfig
  let existing: string | null = null
  try {
    file = fs.realpathSync(userConfig)
    existing = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (existing !== null && hasInclude(existing, target, options.home)) return { changed: false, created: false }
  if (existing === null) {
    const dir = path.dirname(userConfig)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    atomicWriteFileSync(userConfig, includeLines(target), 0o600)
    return { changed: true, created: true }
  }
  const mode = fs.statSync(file).mode & 0o777
  const backup = `${file}.devtool-backup-${stamp(options.now ?? new Date())}`
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(backup, mode & 0o600)
  // At the very top: an Include after a Host line would only apply inside that block.
  atomicWriteFileSync(file, `${includeLines(target)}\n${existing}`, mode)
  return { changed: true, backup, created: false }
}

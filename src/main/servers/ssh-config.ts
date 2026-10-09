import fs from 'fs'
import path from 'path'
import { atomicWriteFileSync } from '../atomic-write'

/**
 * Open in IDE on a DevTool server (plan step 9), the ssh config side.
 *
 * DevTool keeps its own `<configDir>/ssh/config` with one `Host devtool-<id12>`
 * per server, whose ProxyCommand reaches the desktop's socket for that server
 * (and through it, the server's sshd). The user's `~/.ssh/config` gets a single
 * `Include` of that file at the top, so VS Code, Cursor and plain `ssh` see the
 * hosts. Both writes are idempotent; the user's file is backed up before the
 * first change.
 *
 * A server's words never reach the config as they are: an ssh config line can
 * run commands (ProxyCommand, LocalCommand, Match exec), so a server that could
 * smuggle a newline in would run code here. The alias and HostName come from
 * the server's id, the paths are this desktop's, the user must be a plain POSIX
 * login, and the whole file is checked line by line before it is written
 * ({@link assertSafeSshConfig}).
 */

/** Marks the lines DevTool put in the user's ssh config. */
export const INCLUDE_COMMENT = '# Added by DevTool: Open in IDE on DevTool servers (Host devtool-*)'

/** A server's entry in DevTool's ssh config (`<configDir>/ssh/hosts.json`). */
export interface SshHostEntry {
  serverId: string
  /** The login on the server; a plain POSIX user name ({@link isPlainUserName}). */
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

const SERVER_ID = /^[0-9a-f]{32}$/
const ALIAS = /^devtool-[0-9a-f]{12}$/
/** POSIX-ish login names (useradd's default rule), with Samba's trailing `$`. */
const PLAIN_USER = /^[a-z_][a-z0-9_-]{0,31}\$?$/i
const PLAIN_SSH_WORD = /^[A-Za-z0-9_./:@+,=~-]+$/
/** What a desktop path may hold to be quoted safely for ssh_config and its shell. */
const QUOTABLE_PATH = /^[^\0-\x1f\x7f"\\]+$/
const KEY_LINE = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}$/
const EMITTED = new Set(['HostName', 'User', 'ProxyCommand', 'IdentityFile', 'IdentitiesOnly', 'HostKeyAlias', 'UserKnownHostsFile', 'StrictHostKeyChecking'])
const HEADER = [
  '# Written by DevTool for Open in IDE on DevTool servers. DevTool rewrites this file;',
  '# edits are lost. Each host reaches a server\'s sshd through the running DevTool.'
]

/** `devtool-<first 12 hex of the server id>`: the Host alias, never the server's name. */
export function serverAlias(serverId: string): string {
  if (!SERVER_ID.test(serverId)) throw new Error('Not a server id')
  return `devtool-${serverId.slice(0, 12)}`
}

/** A placeholder HostName: the ProxyCommand does the connecting, and `.invalid` never resolves. */
export function placeholderHostName(serverId: string): string {
  return `${serverAlias(serverId)}.invalid`
}

export function isPlainUserName(user: string): boolean {
  return PLAIN_USER.test(user)
}

function assertDesktopPath(value: string): void {
  if (!QUOTABLE_PATH.test(value)) throw new Error(`DevTool can't use the path ${JSON.stringify(value)} in an ssh config`)
}

/** One ssh_config argument (a desktop path): as is when plain, else double-quoted. `%` is doubled (ssh expands tokens). */
export function sshConfigWord(value: string): string {
  assertDesktopPath(value)
  const escaped = value.replace(/%/g, '%%')
  return PLAIN_SSH_WORD.test(value) ? escaped : `"${escaped}"`
}

/** One word (a desktop path) for the shell ssh runs a ProxyCommand with. */
export function shellWord(value: string): string {
  assertDesktopPath(value)
  const escaped = value.replace(/%/g, '%%')
  return PLAIN_SSH_WORD.test(value) ? escaped : `'${escaped.replace(/'/g, `'\\''`)}'`
}

/** The `Host` block for one server. `proxyCommand` is built from desktop paths only ({@link shellWord}). */
export function renderHostBlock(entry: SshHostEntry, proxyCommand: string, paths: SshConfigPaths): string {
  const alias = serverAlias(entry.serverId)
  if (!isPlainUserName(entry.user)) throw new Error(`${JSON.stringify(entry.user)} is not a plain user name`)
  if (/[\0-\x1f\x7f]/.test(proxyCommand)) throw new Error('The ProxyCommand has control characters')
  const lines = [
    `# DevTool server ${entry.serverId}`,
    `Host ${alias}`,
    `  HostName ${placeholderHostName(entry.serverId)}`,
    `  User ${entry.user}`,
    `  ProxyCommand ${proxyCommand}`,
    `  IdentityFile ${sshConfigWord(paths.identityFile)}`,
    '  IdentitiesOnly yes',
    // Host keys are pinned per alias in DevTool's own known_hosts, never the user's.
    `  HostKeyAlias ${alias}`,
    `  UserKnownHostsFile ${sshConfigWord(paths.knownHostsFile)}`,
    '  StrictHostKeyChecking accept-new'
  ]
  return lines.join('\n') + '\n'
}

/**
 * Checks DevTool's ssh config before it is written: only the header, the
 * per-server comment, `Host devtool-<id12>` (each once) and the directives
 * {@link renderHostBlock} emits, one per line, with no control characters.
 */
export function assertSafeSshConfig(text: string): void {
  const aliases = new Set<string>()
  for (const line of text.split('\n')) {
    if (/[\0-\x08\x0b-\x1f\x7f]/.test(line)) throw new Error('The ssh config has control characters')
    if (line === '' || HEADER.includes(line) || /^# DevTool server [0-9a-f]{32}$/.test(line)) continue
    const host = /^Host (\S+)$/.exec(line)
    if (host) {
      if (!ALIAS.test(host[1]) || aliases.has(host[1])) throw new Error(`Unexpected Host line ${JSON.stringify(line)}`)
      aliases.add(host[1])
      continue
    }
    const directive = /^ {2}([A-Za-z]+) (\S.*)$/.exec(line)
    if (!directive || !EMITTED.has(directive[1]) || aliases.size === 0) throw new Error(`Unexpected ssh config line ${JSON.stringify(line)}`)
    if (directive[1] === 'User' && !isPlainUserName(directive[2])) throw new Error(`Unexpected ssh config line ${JSON.stringify(line)}`)
  }
}

/** DevTool's whole ssh config: a header and one block per server, checked. */
export function renderDevtoolSshConfig(blocks: string[]): string {
  const text = [...HEADER, '', ...blocks].join('\n')
  assertSafeSshConfig(text)
  return text
}

/** DevTool's known_hosts: each server's sshd keys under its alias; anything that isn't a plain key line is left out. */
export function renderKnownHosts(entries: SshHostEntry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    for (const key of entry.hostKeys) {
      if (KEY_LINE.test(key)) lines.push(`${serverAlias(entry.serverId)} ${key}`)
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

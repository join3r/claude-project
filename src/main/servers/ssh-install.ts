import { randomBytes } from 'crypto'
import os from 'os'
import { DEFAULT_INSTALL_URL } from '../../shared/servers'
import type { SshInstallExit, SshInstallTarget } from '../../shared/servers'

/**
 * Add server › Install over SSH: runs the installer on a machine this desktop can
 * already reach with the system `ssh`, in a pty the dialog shows, so host key
 * prompts, passwords and 2FA work as in any terminal.
 *
 * The install token never goes on a command line, here or there. The remote
 * command (an argument of ssh, so `ps` shows it on both ends) holds only the
 * install URL: it turns the terminal's echo off, prints a ready marker and reads
 * one line. This side writes the token into the pty when it sees the marker, and
 * the remote hands it to the installer in its environment (`DEVTOOL_TOKEN="$t" sh`).
 */

/** Hosts: names, IPv4, bracketed or bare IPv6 (with a zone). Never an option. */
const HOST_PATTERN = /^(?!-)[A-Za-z0-9_.:%[\]-]{1,253}$/
/** Login names, including `user@domain` ones. Never an option. */
const USER_PATTERN = /^(?!-)[A-Za-z0-9_.@-]{1,64}$/
/** What may appear inside the remote script's double quotes: a plain http(s) URL. */
const INSTALL_URL_PATTERN = /^https?:\/\/[A-Za-z0-9._~:/@%+=,-]+$/

export const SSH_INSTALL_MARKERS = { ready: 'DEVTOOL-SSH-READY', noCurl: 'DEVTOOL-SSH-NOCURL' } as const

/** A readable reason the target can't be used, or null. */
export function sshTargetProblem(target: SshInstallTarget): string | null {
  if (!HOST_PATTERN.test(target.host)) return 'That host name is not valid.'
  if (target.user !== undefined && !USER_PATTERN.test(target.user)) return 'That user name is not valid.'
  if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) return 'The port must be between 1 and 65535.'
  if (target.keyFile !== undefined && (target.keyFile.length === 0 || target.keyFile.length > 1024 || target.keyFile.includes('\0'))) return 'That key file path is not valid.'
  return null
}

/**
 * The command the remote login shell runs. Written for `sh -c` inside single
 * quotes, so it survives bash, zsh, fish and csh as the login shell: no single
 * quotes, backslashes, `!` or newlines inside. The markers are split in two
 * (`"A""-n"`), so only their output, never an echo of this command, matches.
 */
export function remoteInstallScript(installUrl: string, nonce: string): string {
  const base = installUrl.replace(/\/+$/, '')
  if (!INSTALL_URL_PATTERN.test(base)) throw new Error(`Not an install URL: ${installUrl}`)
  if (!/^[0-9a-f]{8,64}$/.test(nonce)) throw new Error('Bad nonce')
  const env = base === DEFAULT_INSTALL_URL ? '' : `DEVTOOL_INSTALL_URL="${base}" `
  const script = [
    'stty -echo 2>/dev/null',
    `command -v curl >/dev/null 2>&1 || { stty echo 2>/dev/null; echo "${SSH_INSTALL_MARKERS.noCurl}""-${nonce}"; exit 3; }`,
    `echo "${SSH_INSTALL_MARKERS.ready}""-${nonce}"`,
    'IFS= read -r t',
    'stty echo 2>/dev/null',
    `curl -fsSL "${base}/install" | ${env}DEVTOOL_TOKEN="$t" sh`
  ].join('; ')
  return `sh -c '${script}'`
}

/** ssh's arguments: a forced tty (the prompts and the hidden read need one), then the target and the script. */
export function buildSshInstallArgs(target: SshInstallTarget, script: string): string[] {
  const problem = sshTargetProblem(target)
  if (problem) throw new Error(problem)
  const args = ['-tt', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4']
  if (target.port !== undefined && target.port !== 22) args.push('-p', String(target.port))
  if (target.keyFile) args.push('-i', expandHome(target.keyFile))
  if (target.user) args.push('-l', target.user)
  args.push(target.host, script)
  return args
}

/** `user@host:port`, as the dialog shows it. */
export function describeSshTarget(target: SshInstallTarget): string {
  const host = target.host.includes(':') && !target.host.startsWith('[') ? `[${target.host}]` : target.host
  return `${target.user ? `${target.user}@` : ''}${host}${target.port !== undefined && target.port !== 22 ? `:${target.port}` : ''}`
}

function expandHome(file: string): string {
  return file === '~' || file.startsWith('~/') ? `${os.homedir()}${file.slice(1)}` : file
}

/** The part of node-pty this uses. */
export interface PtyLike {
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type SpawnPty = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyLike

export interface SshInstallDeps {
  spawn: SpawnPty
  /** To the window that started the session only. */
  send: (clientId: string, channel: string, ...args: unknown[]) => void
  /** The live install token: the waiting invite's, or a new invite's. Asked when the remote is ready. */
  token: () => string
  installUrl: () => string
  /** The system ssh. */
  ssh: () => string
  env: () => Record<string, string>
  log: (message: string) => void
  /** Tests: a fixed marker nonce. */
  nonce?: () => string
}

export const SSH_INSTALL_DATA = 'servers-ssh-install-data'
export const SSH_INSTALL_EXIT = 'servers-ssh-install-exit'

interface Session {
  id: string
  clientId: string
  pty: PtyLike
  filter: MarkerFilter
  token: string | null
  reason: SshInstallExit['reason']
  stopped: boolean
}

/** The running SSH installs, one pty each, owned by the window that started it. */
export class SshInstallSessions {
  private readonly sessions = new Map<string, Session>()
  private nextId = 1

  constructor(private readonly deps: SshInstallDeps) {}

  start(clientId: string, target: SshInstallTarget, size: { cols: number; rows: number }): { sessionId: string; target: string } {
    const nonce = this.deps.nonce?.() ?? randomBytes(8).toString('hex')
    const args = buildSshInstallArgs(target, remoteInstallScript(this.deps.installUrl(), nonce))
    const id = `ssh-install-${this.nextId++}`
    const pty = this.deps.spawn(this.deps.ssh(), args, {
      name: 'xterm-256color',
      cols: clampSize(size.cols, 20, 400, 80),
      rows: clampSize(size.rows, 4, 200, 24),
      cwd: os.homedir(),
      env: { ...this.deps.env(), TERM: 'xterm-256color' }
    })
    const session: Session = {
      id,
      clientId,
      pty,
      token: null,
      reason: null,
      stopped: false,
      filter: new MarkerFilter([`${SSH_INSTALL_MARKERS.ready}-${nonce}`, `${SSH_INSTALL_MARKERS.noCurl}-${nonce}`])
    }
    this.sessions.set(id, session)
    this.deps.log(`servers ssh-install start id=${id} target=${describeSshTarget(target)}`)
    pty.onData((data) => this.onData(session, data, nonce))
    pty.onExit(({ exitCode }) => {
      if (this.sessions.get(id) !== session) return
      this.sessions.delete(id)
      const tail = session.filter.flush()
      if (tail) this.deps.send(clientId, SSH_INSTALL_DATA, id, this.redact(session, tail))
      const exit: SshInstallExit = { exitCode, reason: session.stopped ? 'stopped' : session.reason, tokenSent: session.token !== null }
      this.deps.log(`servers ssh-install exit id=${id} code=${exitCode} reason=${exit.reason ?? '-'} tokenSent=${exit.tokenSent}`)
      this.deps.send(clientId, SSH_INSTALL_EXIT, id, exit)
    })
    return { sessionId: id, target: describeSshTarget(target) }
  }

  write(clientId: string, sessionId: string, data: string): void {
    const session = this.owned(clientId, sessionId)
    session?.pty.write(data)
  }

  resize(clientId: string, sessionId: string, cols: number, rows: number): void {
    const session = this.owned(clientId, sessionId)
    try {
      session?.pty.resize(clampSize(cols, 20, 400, 80), clampSize(rows, 4, 200, 24))
    } catch {
      // Already exited.
    }
  }

  stop(clientId: string, sessionId: string): void {
    const session = this.owned(clientId, sessionId)
    if (session) this.kill(session)
  }

  /** The window closed: its installs stop. */
  detachClient(clientId: string): void {
    for (const session of [...this.sessions.values()]) if (session.clientId === clientId) this.kill(session)
  }

  stopAll(): void {
    for (const session of [...this.sessions.values()]) this.kill(session)
  }

  private owned(clientId: string, sessionId: string): Session | null {
    const session = this.sessions.get(sessionId)
    return session && session.clientId === clientId ? session : null
  }

  private kill(session: Session): void {
    session.stopped = true
    try {
      session.pty.kill()
    } catch {
      // Already gone.
    }
  }

  private onData(session: Session, data: string, nonce: string): void {
    const out = session.filter.push(data, (marker) => {
      if (marker === `${SSH_INSTALL_MARKERS.noCurl}-${nonce}`) {
        session.reason = 'no-curl'
        return
      }
      if (session.token !== null) return
      try {
        session.token = this.deps.token()
      } catch (err) {
        this.deps.log(`servers ssh-install id=${session.id} no token: ${err instanceof Error ? err.message : String(err)}`)
        session.reason = 'no-token'
        this.kill(session)
        return
      }
      // The remote has echo off and waits in `read`; ssh keeps this pty raw, so nothing echoes here either.
      session.pty.write(`${session.token}\n`)
      this.deps.log(`servers ssh-install id=${session.id} remote ready, token sent`)
    })
    if (out) this.deps.send(session.clientId, SSH_INSTALL_DATA, session.id, this.redact(session, out))
  }

  /** Should a remote echo the token after all (no stty there), it still never reaches the window. */
  private redact(session: Session, text: string): string {
    return session.token ? text.split(session.token).join('[token hidden]') : text
  }
}

function clampSize(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback
}

/**
 * Takes the markers out of a stream of terminal output and calls back for each.
 * Text that could be the start of a marker is held until it can tell; after the
 * first marker the rest passes straight through. The marker's own line break
 * goes with it.
 */
export class MarkerFilter {
  private pending = ''
  private done = false
  /** After a marker at the end of a chunk: its line break may come with the next one. */
  private dropNewline: 'crlf' | 'lf' | null = null

  constructor(private readonly markers: string[]) {}

  push(chunk: string, onMarker: (marker: string) => void): string {
    if (this.dropNewline) {
      const expect = this.dropNewline
      this.dropNewline = null
      if (expect === 'crlf' && chunk === '\r') {
        this.dropNewline = 'lf'
        return ''
      }
      chunk = expect === 'crlf' ? chunk.replace(/^\r?\n/, '') : chunk.replace(/^\n/, '')
    }
    if (this.done) return chunk
    const text = this.pending + chunk
    this.pending = ''
    let found: { index: number; marker: string } | null = null
    for (const marker of this.markers) {
      const index = text.indexOf(marker)
      if (index >= 0 && (!found || index < found.index)) found = { index, marker }
    }
    if (found) {
      const before = text.slice(0, found.index)
      let after = text.slice(found.index + found.marker.length)
      this.done = true
      onMarker(found.marker)
      if (after === '') this.dropNewline = 'crlf'
      else if (after === '\r') { this.dropNewline = 'lf'; after = '' }
      else after = after.replace(/^\r?\n/, '')
      return before + after
    }
    const hold = this.heldSuffix(text)
    this.pending = text.slice(text.length - hold)
    return text.slice(0, text.length - hold)
  }

  /** What is still held back (at exit). */
  flush(): string {
    const rest = this.pending
    this.pending = ''
    return rest
  }

  /** The longest end of `text` that some marker starts with. */
  private heldSuffix(text: string): number {
    let best = 0
    for (const marker of this.markers) {
      for (let n = Math.min(marker.length - 1, text.length); n > best; n--) {
        if (text.endsWith(marker.slice(0, n))) {
          best = n
          break
        }
      }
    }
    return best
  }
}

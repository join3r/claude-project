/**
 * Move an SSH project to a DevTool server (plan step 11): the pure parts that
 * main and the dialog share. The project keeps every id (project, streams,
 * tasks, tabs), so notes, pins, order, tags and agent session ids carry over;
 * its folder, worktrees and sessions are already on the server's disk, because
 * the server runs on the machine the project reached over SSH.
 */
import type { ProjectArchive } from './archive'
import type { ServerStatus, SshHostProbe, SshInstallTarget } from './servers'
import type { Project, SshConfig, Stream, Task } from './types'
import { normalizeRelayUrl } from './mobile'

/** Only an SSH project of this desktop moves: a server's project already lives on one. */
export function canMoveToServer(project: Pick<Project, 'ssh' | 'host'>): boolean {
  return !!project.ssh && !project.host
}

/**
 * The project's folder as the server is asked for it: `~` for an empty remote
 * directory (the SSH project started in the user's home), a relative one under
 * `~/` (an SSH session `cd`s from home), an absolute one as it is.
 */
export function serverPathForRemoteDir(remoteDir: string | undefined): string {
  const dir = (remoteDir ?? '').trim()
  if (!dir || dir === '~') return '~'
  if (dir.startsWith('/') || dir.startsWith('~/')) return dir
  return `~/${dir}`
}

/** Install over SSH's target for an SSH project's machine (port 22 and an empty user left to ssh). */
export function sshInstallTargetOf(ssh: SshConfig): SshInstallTarget {
  return {
    host: ssh.host,
    ...(ssh.username ? { user: ssh.username } : {}),
    ...(ssh.port && ssh.port !== 22 ? { port: ssh.port } : {}),
    ...(ssh.keyFile ? { keyFile: ssh.keyFile } : {})
  }
}

/** Every tab of the project, task by task. */
export function projectTabIds(project: Project): string[] {
  return project.streams.flatMap(stream => stream.tasks.flatMap(task => task.panes.flatMap(pane => pane.tabs.map(tab => tab.id))))
}

/** A task that worked in its stream's worktree keeps doing so: its agents' sessions are keyed by that folder. */
function sharingStreamWorktree(task: Task): Task {
  return task.workspace || task.sharesStreamWorktree ? task : { ...task, sharesStreamWorktree: true }
}

function withSharedTasks(stream: Stream): Stream {
  if (!stream.workspace) return stream
  return { ...stream, taskWorktrees: true, tasks: stream.tasks.map(sharingStreamWorktree) }
}

/**
 * The project as its server stores it: the same ids and everything else, its
 * folder on the server as `directory`, and no `ssh`, `tunnel` or `host`.
 *
 * Over SSH a worktree stream's tasks all ran in the stream's worktree. On a
 * server a new task gets a worktree of its own, so the tasks that came along are
 * stamped `sharesStreamWorktree`: their terminals and agents restart in the same
 * folder, which is what lets Claude, Codex and Pi resume their sessions.
 */
export function serverProjectFrom(project: Project, directory: string): Project {
  const { ssh: _ssh, tunnel: _tunnel, host: _host, ...rest } = project
  return { ...rest, directory, streams: project.streams.map(withSharedTasks) }
}

/** The project's archive as the server keeps it: archived tasks of worktree streams keep sharing those worktrees on reopen. */
export function serverArchiveFrom(archive: ProjectArchive, project: Project): ProjectArchive {
  const worktreeStreams = new Set(project.streams.filter(stream => stream.workspace).map(stream => stream.id))
  for (const entry of archive.streams) if (entry.stream.workspace) worktreeStreams.add(entry.stream.id)
  return {
    ...archive,
    tasks: archive.tasks.map(entry => (worktreeStreams.has(entry.streamId) ? { ...entry, task: sharingStreamWorktree(entry.task) } : entry)),
    streams: archive.streams.map(entry => (entry.stream.workspace
      ? {
          ...entry,
          stream: withSharedTasks(entry.stream),
          doneTasks: entry.doneTasks.map(done => ({ ...done, task: sharingStreamWorktree(done.task) }))
        }
      : entry))
  }
}

// --- Which server runs on the SSH host ---------------------------------------

/**
 * Where the project goes:
 * - `paired`: that very server runs on the SSH host and is paired here.
 * - `install`: no paired server runs there; Install over SSH (it also pairs an
 *   unpaired server already installed there on this relay).
 * - `other-relay`: a server is installed there on another relay, so this
 *   desktop can't pair with it (installing would move it, and cut off its desktops).
 * - `ask`: DevTool can't tell. `candidates` are the paired servers to offer
 *   next to Install, the likely ones first; `likely` is a single strong guess.
 */
export type ServerMatch =
  | { kind: 'paired'; serverId: string }
  | { kind: 'install' }
  | { kind: 'other-relay'; relayUrl: string }
  | { kind: 'ask'; candidates: string[]; likely?: string }

/** Host names that name the same machine: equal, or equal before the first dot (`dev` and `dev.example.com`). */
export function sameHostName(a: string | undefined, b: string | undefined): boolean {
  const x = (a ?? '').trim().toLowerCase().replace(/\.local$/, '').replace(/\.$/, '')
  const y = (b ?? '').trim().toLowerCase().replace(/\.local$/, '').replace(/\.$/, '')
  if (!x || !y) return false
  if (x === y) return true
  const isIp = (name: string) => /^[\d.]+$/.test(name) || name.includes(':')
  if (isIp(x) || isIp(y)) return false
  return x.split('.')[0] === y.split('.')[0]
}

export function sameRelay(a: string, b: string): boolean {
  return normalizeRelayUrl(a).toLowerCase() === normalizeRelayUrl(b).toLowerCase()
}

/** A paired server that reports this machine (host name, and user when it says). */
function reportsMachine(server: ServerStatus, hostname: string, user: string | undefined): boolean {
  const host = server.host
  if (!host || !sameHostName(host.hostname, hostname)) return false
  return !user || !host.user || host.user === user
}

/**
 * Which server an SSH project moves to. `probe` is what the SSH host said
 * about itself (null when ssh couldn't ask it); `relayUrl` is this desktop's relay.
 */
export function matchServerForSsh(input: {
  ssh: Pick<SshConfig, 'host' | 'username'>
  servers: readonly ServerStatus[]
  probe: SshHostProbe | null
  relayUrl: string
}): ServerMatch {
  const { ssh, servers, probe, relayUrl } = input
  const paired = new Set(servers.map(server => server.id))
  if (probe) {
    if (probe.serverId && paired.has(probe.serverId)) return { kind: 'paired', serverId: probe.serverId }
    if (probe.installed && probe.relayUrl && !sameRelay(probe.relayUrl, relayUrl)) return { kind: 'other-relay', relayUrl: probe.relayUrl }
    // A server runs there and isn't ours: the installer pairs it (same relay).
    if (probe.serverId) return { kind: 'install' }
    const reporting = servers.filter(server => reportsMachine(server, probe.hostname, probe.user)).map(server => server.id)
    if (reporting.length === 0) return { kind: 'install' }
    // A paired server says it is this machine, but nothing runs in the default
    // home there: another home, or another machine with the same name.
    return { kind: 'ask', candidates: reporting, ...(reporting.length === 1 ? { likely: reporting[0] } : {}) }
  }
  if (servers.length === 0) return { kind: 'install' }
  // No answer from the host: every paired server is a candidate, the ones whose
  // host name matches the SSH host first.
  const likely = servers.filter(server => reportsMachine(server, ssh.host, ssh.username)).map(server => server.id)
  const rest = servers.map(server => server.id).filter(id => !likely.includes(id))
  return { kind: 'ask', candidates: [...likely, ...rest], ...(likely.length === 1 ? { likely: likely[0] } : {}) }
}

// --- The probe ----------------------------------------------------------------

export const SSH_PROBE_MARKER = 'DEVTOOL-PROBE-1'

/**
 * The command the SSH host runs to describe itself. Written for `sh -c` inside
 * single quotes (as the install script is), so bash, zsh, fish and csh login
 * shells all pass it on unchanged: no single quotes, backslashes or `!` inside.
 */
export function sshProbeScript(): string {
  const script = [
    'd="${DEVTOOL_SERVER_HOME:-$HOME/.devtool-server}"',
    `echo ${SSH_PROBE_MARKER}`,
    'echo "host=$(hostname 2>/dev/null || uname -n)"',
    'echo "user=$(id -un 2>/dev/null)"',
    'if [ -d "$d" ]; then echo installed=1; ' +
      'if [ -f "$d/data/server.json" ]; then echo "config=$(head -c 4096 "$d/data/server.json" | tr -s "[:space:]" " ")"; fi; ' +
      'if [ -x "$d/bin/devtool-server" ]; then echo "status=$("$d/bin/devtool-server" status 2>/dev/null | head -n 1)"; fi; ' +
      'else echo installed=0; fi'
  ].join('; ')
  return `sh -c '${script}'`
}

/** Reads {@link sshProbeScript}'s output (anything before the marker, a banner, is skipped); null without the marker. */
export function parseSshProbe(stdout: string): SshHostProbe | null {
  const lines = stdout.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === SSH_PROBE_MARKER)
  if (start < 0) return null
  const values = new Map<string, string>()
  for (const line of lines.slice(start + 1)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!values.has(key)) values.set(key, line.slice(eq + 1).trim())
  }
  const probe: SshHostProbe = {
    hostname: values.get('host') ?? '',
    user: values.get('user') ?? '',
    installed: values.get('installed') === '1'
  }
  const status = values.get('status') ?? ''
  const id = /\(([0-9a-f]{32})\)\s*$/.exec(status)
  if (id) probe.serverId = id[1]
  const config = values.get('config')
  if (config) {
    try {
      const parsed = JSON.parse(config) as { relayUrl?: unknown }
      if (typeof parsed.relayUrl === 'string' && parsed.relayUrl) probe.relayUrl = parsed.relayUrl
    } catch {
      // Unreadable: as if the server named no relay.
    }
  }
  return probe
}

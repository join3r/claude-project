import type { Project, SavedHost, SshConfig } from '../shared/types'
import type { ServerStatus } from '../shared/servers'

/**
 * Hosts (change 6 of the 2026-10-30 redesign): where a project's code runs,
 * listed once. This Mac, every paired DevTool server, every SSH box and every
 * custom shell. There is no host record in the project data: a project's host
 * is read from the fields it always had (`host` = server id, `ssh`,
 * `shellCommand`, else this Mac), and Settings › Hosts keeps (`config.hosts`)
 * only the SSH boxes and shells added before any project uses them.
 */

export type HostKind = 'mac' | 'server' | 'ssh' | 'shell'

/** A dot's colour: green fine, grey idle or on its way, red broken. */
export type HostTone = 'ok' | 'idle' | 'bad'

/** The part of an SSH config that names the box; the folder is the project's. */
export type SshBox = Pick<SshConfig, 'host' | 'port' | 'username' | 'keyFile'>

export interface HostEntry {
  /** `mac`, `server:<id>`, `ssh:user@host:port`, `shell:<command>`. */
  key: string
  kind: HostKind
  label: string
  /** Under the label: the address or the command. */
  sub?: string
  /** After the label: "offline", "not connected"… Absent while all is well. */
  detail?: string
  tone: HostTone
  /** Projects on it (ephemeral ones left out), in the order given. */
  projects: Project[]
  /** Kept in `config.hosts` (an SSH box or shell): Remove is offered while no project uses it. */
  saved: boolean
  server?: ServerStatus
  ssh?: SshBox
  command?: string
}

/** SSH master states as main reports them (`ssh-status`), by project id. */
export type SshStatuses = Readonly<Record<string, string>>

export const MAC_HOST_KEY = 'mac'

export function serverHostKey(serverId: string): string {
  return `server:${serverId}`
}

/** `user@host:port`: two boxes differ when any of the three does; the key file doesn't make another box. */
export function sshBoxAddress(box: Pick<SshBox, 'host' | 'port' | 'username'>): string {
  return `${box.username ? `${box.username}@` : ''}${box.host}:${box.port || 22}`
}

export function sshHostKey(box: Pick<SshBox, 'host' | 'port' | 'username'>): string {
  return `ssh:${sshBoxAddress(box)}`
}

export function shellHostKey(command: string): string {
  return `shell:${command.trim()}`
}

export function savedHostKey(host: SavedHost): string {
  return host.kind === 'ssh' ? sshHostKey(host) : shellHostKey(host.command)
}

/** The host a project runs on, by the fields it already has. */
export function projectHostKey(project: Project): string {
  if (project.host) return serverHostKey(project.host)
  if (project.ssh) return sshHostKey(project.ssh)
  if (project.shellCommand) return shellHostKey(project.shellCommand.command)
  return MAC_HOST_KEY
}

const SERVER_TONE: Record<ServerStatus['state'], { detail?: string; tone: HostTone }> = {
  online: { tone: 'ok' },
  connecting: { detail: 'connecting', tone: 'idle' },
  updating: { detail: 'updating', tone: 'idle' },
  offline: { detail: 'offline', tone: 'idle' },
  incompatible: { detail: 'needs an update', tone: 'bad' }
}

/** A shell's words: its saved name, else the project's name when one project uses it, else the command. */
function shellLabel(command: string, saved: SavedHost | undefined, projects: readonly Project[]): string {
  if (saved?.kind === 'shell' && saved.name.trim()) return saved.name.trim()
  if (projects.length === 1) return projects[0].name
  return command
}

/**
 * Every host, in order: this Mac, the paired servers (by name), the SSH boxes
 * (by address), the custom shells (by label). A box or shell shows when a
 * project uses it or `saved` keeps it. An SSH box is connected when any of its
 * projects' masters is; one at rest is grey, not broken (masters open on use).
 * A server a project still names but that is no longer paired shows as "not
 * paired", so its projects stay visible somewhere.
 */
export function listHosts(
  projects: readonly Project[],
  servers: readonly ServerStatus[],
  sshStatuses: SshStatuses,
  saved: readonly SavedHost[] = []
): HostEntry[] {
  const real = projects.filter(project => !project.ephemeral)
  const byKey = new Map<string, Project[]>()
  for (const project of real) {
    const key = projectHostKey(project)
    byKey.set(key, [...(byKey.get(key) ?? []), project])
  }
  const used = (key: string): Project[] => byKey.get(key) ?? []

  const out: HostEntry[] = [{ key: MAC_HOST_KEY, kind: 'mac', label: 'This Mac', tone: 'ok', projects: used(MAC_HOST_KEY), saved: false }]

  const serverKeys = new Set<string>()
  for (const server of [...servers].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = serverHostKey(server.id)
    serverKeys.add(key)
    const { detail, tone } = SERVER_TONE[server.state] ?? SERVER_TONE.offline
    out.push({
      key,
      kind: 'server',
      label: server.name || `server ${server.id.slice(0, 6)}`,
      sub: 'DevTool server',
      detail,
      tone,
      projects: used(key),
      saved: false,
      server
    })
  }
  for (const [key, list] of byKey) {
    if (!key.startsWith('server:') || serverKeys.has(key)) continue
    out.push({ key, kind: 'server', label: `server ${key.slice(7, 13)}`, sub: 'DevTool server', detail: 'not paired', tone: 'bad', projects: list, saved: false })
  }

  const savedByKey = new Map(saved.map(host => [savedHostKey(host), host]))

  const boxes = new Map<string, SshBox>()
  for (const host of saved) if (host.kind === 'ssh') boxes.set(sshHostKey(host), { host: host.host, port: host.port, username: host.username, ...(host.keyFile ? { keyFile: host.keyFile } : {}) })
  for (const project of real) {
    if (!project.ssh) continue
    const key = sshHostKey(project.ssh)
    if (!boxes.has(key)) {
      const { host, port, username, keyFile } = project.ssh
      boxes.set(key, { host, port, username, ...(keyFile ? { keyFile } : {}) })
    }
  }
  for (const [key, box] of [...boxes].sort((a, b) => sshBoxAddress(a[1]).localeCompare(sshBoxAddress(b[1])))) {
    const list = used(key)
    const states = list.map(project => sshStatuses[project.id] ?? 'disconnected')
    const connected = states.includes('connected')
    const connecting = !connected && states.includes('connecting')
    out.push({
      key,
      kind: 'ssh',
      label: box.host,
      sub: sshBoxAddress(box),
      detail: connected ? undefined : connecting ? 'connecting' : 'not connected',
      tone: connected ? 'ok' : 'idle',
      projects: list,
      saved: savedByKey.has(key),
      ssh: box
    })
  }

  const shells = new Map<string, string>()
  for (const host of saved) if (host.kind === 'shell') shells.set(shellHostKey(host.command), host.command.trim())
  for (const project of real) {
    if (!project.shellCommand || project.host || project.ssh) continue
    const key = shellHostKey(project.shellCommand.command)
    if (!shells.has(key)) shells.set(key, project.shellCommand.command.trim())
  }
  const shellEntries: HostEntry[] = [...shells].map(([key, command]) => {
    const list = used(key)
    return {
      key,
      kind: 'shell',
      label: shellLabel(command, savedByKey.get(key), list),
      sub: command,
      tone: 'ok',
      projects: list,
      saved: savedByKey.has(key),
      command
    }
  })
  out.push(...shellEntries.sort((a, b) => a.label.localeCompare(b.label)))
  return out
}

/** `saved` plus `host`, replacing one with the same key (a new key file or name). */
export function addSavedHost(saved: readonly SavedHost[], host: SavedHost): SavedHost[] {
  const key = savedHostKey(host)
  return [...saved.filter(h => savedHostKey(h) !== key), host]
}

export function removeSavedHost(saved: readonly SavedHost[], key: string): SavedHost[] {
  return saved.filter(h => savedHostKey(h) !== key)
}

/**
 * The hosts an existing project can be switched to from its settings. Moving
 * between kinds would strand its tasks' worktrees and tabs on the old machine,
 * so only these: its own host; for a custom shell, the other shells (the
 * command only runs when a tab opens); for an SSH project that can move, the
 * online servers (that runs Move to a DevTool server…, which copies it there).
 */
export function hostChoicesFor(project: Project, hosts: readonly HostEntry[], canMoveToServer: boolean): HostEntry[] {
  const own = projectHostKey(project)
  return hosts.filter(host => {
    if (host.key === own) return true
    if (project.shellCommand && !project.host && !project.ssh) return host.kind === 'shell'
    if (project.ssh && canMoveToServer) return host.kind === 'server' && host.server?.state === 'online'
    return false
  })
}

/** What New project offers: every host, with servers that aren't online and so can't make a folder held back. */
export function newProjectHostUsable(host: HostEntry): boolean {
  return host.kind !== 'server' || host.server?.state === 'online'
}

/** A folder's last segment, for a project's default name (`/a/b/` → `b`, `C:\\x\\y` → `y`). */
export function folderName(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

/** The project actions New project needs, one per kind of host. */
export interface HostProjectActions {
  addProject: (name: string, directory: string) => Project
  addServerProjects: (serverId: string, items: Array<{ name: string; directory: string }>) => Project[]
  addRemoteProject: (name: string, ssh: SshConfig) => Project
  addShellCommandProject: (name: string, command: string) => Project
}

/**
 * New project's one Host field, mapped onto the fields a project always had:
 * this Mac → a plain folder, a server → `host` (the folder is on it), an SSH box
 * → `ssh` with the folder as `remoteDir`, a shell → `shellCommand` (no folder).
 */
export function createProjectOnHost(actions: HostProjectActions, host: HostEntry, name: string, directory: string): Project | null {
  const folder = directory.trim()
  const title = name.trim() || folderName(folder)
  switch (host.kind) {
    case 'mac':
      return folder && title ? actions.addProject(title, folder) : null
    case 'server':
      return host.server && folder && title ? actions.addServerProjects(host.server.id, [{ name: title, directory: folder }])[0] ?? null : null
    case 'ssh':
      return host.ssh && folder && title ? actions.addRemoteProject(title, { ...host.ssh, remoteDir: folder }) : null
    case 'shell':
      return host.command && name.trim() ? actions.addShellCommandProject(name.trim(), host.command) : null
  }
}

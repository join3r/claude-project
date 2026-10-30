import type { Project } from '../../../shared/types'
import type { ServerStatus } from '../../../shared/servers'
import type { MobileState } from '../../../shared/mobile'
import { streamRunTask } from '../../../shared/stream-run'
import type { InboxApp } from '../inbox'

/**
 * The desk's status bar (change 7 of the redesign), one quiet line along the
 * bottom of the window: the hosts code runs on (this Mac, the paired DevTool
 * servers, the SSH boxes projects use) on the left; the stream commands that
 * run or crashed, and the phone, on the right. Colour means state only.
 */

/** A dot's colour: green fine, grey idle or on its way, red broken, amber waiting on you. */
export type StatusTone = 'ok' | 'idle' | 'bad' | 'needs'

export interface StatusHost {
  key: string
  kind: 'mac' | 'server' | 'ssh'
  label: string
  /** After the label: "offline", "connecting"… Absent while all is well. */
  detail?: string
  tone: StatusTone
  title: string
}

/** SSH connection states as main reports them (`ssh-status`), by project id. */
export type SshStatuses = Readonly<Record<string, string>>

const SERVER_DETAIL: Record<ServerStatus['state'], { detail?: string; tone: StatusTone }> = {
  online: { tone: 'ok' },
  connecting: { detail: 'connecting', tone: 'idle' },
  updating: { detail: 'updating', tone: 'idle' },
  offline: { detail: 'offline', tone: 'idle' },
  incompatible: { detail: 'needs an update', tone: 'bad' }
}

/**
 * The hosts, in order: this Mac, every paired server (by name), then one entry
 * per SSH box (`user@host:port`) the projects use, connected when any of its
 * projects' masters is. An SSH box at rest isn't broken: masters open on use.
 */
export function statusHosts(projects: readonly Project[], servers: readonly ServerStatus[], ssh: SshStatuses): StatusHost[] {
  const out: StatusHost[] = [{ key: 'mac', kind: 'mac', label: 'This Mac', tone: 'ok', title: 'This Mac' }]
  for (const server of [...servers].sort((a, b) => a.name.localeCompare(b.name))) {
    const { detail, tone } = SERVER_DETAIL[server.state] ?? SERVER_DETAIL.offline
    out.push({
      key: `server:${server.id}`,
      kind: 'server',
      label: server.name || `server ${server.id.slice(0, 6)}`,
      detail,
      tone,
      title: `DevTool server · ${server.error ?? detail ?? 'online'}`
    })
  }
  const boxes = new Map<string, { label: string; names: string[]; statuses: string[] }>()
  for (const project of projects) {
    if (!project.ssh || project.ephemeral) continue
    const { username, host, port } = project.ssh
    const key = `${username}@${host}:${port}`
    const box = boxes.get(key) ?? { label: host, names: [], statuses: [] }
    box.names.push(project.name)
    box.statuses.push(ssh[project.id] ?? 'disconnected')
    boxes.set(key, box)
  }
  for (const [key, box] of [...boxes].sort((a, b) => a[1].label.localeCompare(b[1].label))) {
    const connected = box.statuses.includes('connected')
    const connecting = !connected && box.statuses.includes('connecting')
    out.push({
      key: `ssh:${key}`,
      kind: 'ssh',
      label: `${box.label} (ssh)`,
      detail: connected ? undefined : connecting ? 'connecting' : 'not connected',
      tone: connected ? 'ok' : 'idle',
      title: `${key} · ${box.names.join(', ')}`
    })
  }
  return out
}

/** A run's words on the bar: "devtool · dev", "stem › beta · server crashed". */
export function statusRunLabel(app: InboxApp): string {
  const where = app.stream.isMain ? app.project.name : `${app.project.name} › ${app.stream.name}`
  return `${where} · ${app.run.name}${app.crashed ? ' crashed' : ''}`
}

/**
 * The task whose Bench shows a run's log: the task it runs in, else the task
 * this window shows when it's of the same project (a dev server of the stream
 * the user is working in). Null when neither: the log opens as a modal.
 */
export function runLogTaskId(
  app: InboxApp,
  selected: { projectId: string | null; taskId: string | null }
): string | null {
  const own = streamRunTask(app.stream, app.run)
  if (own) return own.id
  if (!selected.taskId || selected.projectId !== app.project.id) return null
  return app.project.streams.some(stream => stream.tasks.some(task => task.id === selected.taskId)) ? selected.taskId : null
}

export interface StatusPhone {
  label: string
  detail?: string
  tone: StatusTone
  title: string
}

/**
 * The phone entry: nothing while mobile access is off and nothing is paired;
 * amber while a phone waits to be accepted; otherwise the paired phone (or how
 * many), green while one is online.
 */
export function statusPhone(mobile: MobileState | null): StatusPhone | null {
  if (!mobile) return null
  if (mobile.pending) return { label: `${mobile.pending.name || 'A phone'} wants to pair`, tone: 'needs', title: 'Accept or reject it in Settings › Mobile' }
  const devices = mobile.devices
  if (!mobile.enabled) {
    return devices.length > 0 ? { label: 'Phone access off', tone: 'idle', title: 'Turn it on in Settings › Mobile' } : null
  }
  if (devices.length === 0) {
    return mobile.invite
      ? { label: 'Pairing…', tone: 'idle', title: 'Scan the code in Settings › Mobile' }
      : { label: 'No phone paired', tone: 'idle', title: 'Pair a phone in Settings › Mobile' }
  }
  const label = devices.length === 1 ? devices[0].name || 'Phone' : `${devices.length} phones`
  if (devices.some(device => device.outdated)) return { label, detail: 'needs an update', tone: 'bad', title: 'A phone and this Mac need the same protocol version' }
  if (mobile.connection.kind !== 'online') {
    return { label, detail: 'relay offline', tone: 'idle', title: mobile.connection.kind === 'offline' && mobile.connection.error ? mobile.connection.error : 'Not connected to the relay' }
  }
  const online = devices.filter(device => device.online).length
  return online > 0
    ? { label, detail: devices.length > 1 ? `${online} online` : undefined, tone: 'ok', title: 'Paired · online' }
    : { label, detail: 'paired', tone: 'idle', title: 'Paired · not connected right now' }
}

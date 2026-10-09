import fs from 'fs'
import path from 'path'
import { atomicWriteFileSync, readJsonRecord } from '../storage'
import {
  LOCAL_SOURCE,
  emptyProjectsData,
  withHost,
  withoutHost,
  type ProjectsSources,
  type ProjectsUpdate,
  type SourceEnvelope,
  type SourceSaveResult
} from '../../shared/projects-sources'
import type { Project, ProjectsData, ProjectsSaveResult, Stream, Task, TaskPane } from '../../shared/types'
import type { ServersState } from '../../shared/servers'
import { LinkError, LinkErrorCode } from '../host/link/errors'

/** Desktop main's own client id on its servers, for the calls no window makes (loading their projects). */
export const MAIN_CLIENT_ID = 'main'

/** The part of {@link ServerHub} this needs: a fake in tests. */
export interface ServerProjectsHub {
  call(serverId: string, clientId: string, ch: string, args?: unknown[], options?: { focused?: boolean }): Promise<unknown>
  getState(): ServersState
  onStateChange(listener: (state: ServersState) => void): () => void
}

export interface ServerProjectsDeps {
  configDir: string
  /** This desktop's own projects: a server's ids that collide with theirs are dropped. */
  localProjects?: () => readonly Project[]
  /** Tell every local window about a server's new slice. */
  broadcast: (update: ProjectsUpdate) => void
  log: (message: string) => void
}

interface Entry {
  /** The server's revision of `data`. */
  revision: number
  /** The server's whole ProjectsData, as it stores it (no `host`). */
  data: ProjectsData
}

/** Server ids are base64url device ids; anything else never names a directory. */
const SERVER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** The ids a set of projects uses, by kind. */
interface Claimed {
  projects: Set<string>
  streams: Set<string>
  tasks: Set<string>
  tabs: Set<string>
}

function claimedBy(projects: readonly Project[]): Claimed {
  const claimed: Claimed = { projects: new Set(), streams: new Set(), tasks: new Set(), tabs: new Set() }
  for (const project of projects) {
    claimed.projects.add(project.id)
    for (const stream of Array.isArray(project.streams) ? project.streams : []) {
      claimed.streams.add(stream.id)
      for (const task of Array.isArray(stream.tasks) ? stream.tasks : []) {
        claimed.tasks.add(task.id)
        for (const pane of Array.isArray(task.panes) ? task.panes : []) {
          for (const tab of Array.isArray(pane.tabs) ? pane.tabs : []) claimed.tabs.add(tab.id)
        }
      }
    }
  }
  return claimed
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** A browser tab's page from a server: web pages only, never this desktop's files or other schemes. */
function webUrlOrNothing(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || url === 'about:blank' ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * A server's project as this desktop may use it, or null: `host` is the server,
 * it is never an SSH project (no `ssh` or `tunnel`: this desktop would connect
 * on the server's say-so), and every project, stream, task and tab id already
 * claimed (by this desktop, an earlier server, or earlier in this data) is
 * dropped, so a server can't take over a local tab's calls. Kept ids are claimed.
 * A browser tab keeps its page only when it is a web page (a `file:` URL would
 * show this desktop's files in a server's tab).
 */
function sanitizeProject(raw: Project, serverId: string, claimed: Claimed, dropped: string[]): Project | null {
  if (!raw || !isId(raw.id) || claimed.projects.has(raw.id)) {
    dropped.push(`project:${raw?.id}`)
    return null
  }
  const streams: Stream[] = []
  for (const stream of Array.isArray(raw.streams) ? raw.streams : []) {
    if (!stream || !isId(stream.id) || claimed.streams.has(stream.id)) {
      dropped.push(`stream:${stream?.id}`)
      continue
    }
    const tasks: Task[] = []
    for (const task of Array.isArray(stream.tasks) ? stream.tasks : []) {
      if (!task || !isId(task.id) || claimed.tasks.has(task.id)) {
        dropped.push(`task:${task?.id}`)
        continue
      }
      const panes: TaskPane[] = []
      for (const pane of Array.isArray(task.panes) ? task.panes : []) {
        const tabs = (Array.isArray(pane?.tabs) ? pane.tabs : []).filter(tab => {
          if (tab && isId(tab.id) && !claimed.tabs.has(tab.id)) {
            claimed.tabs.add(tab.id)
            return true
          }
          dropped.push(`tab:${tab?.id}`)
          return false
        }).map(tab => {
          if (tab.url === undefined) return tab
          const { url, ...rest } = tab
          const safe = webUrlOrNothing(url)
          return safe === undefined ? rest : { ...rest, url: safe }
        })
        if (tabs.length === 0 && (pane?.tabs?.length ?? 0) > 0) continue
        const activeTabId = tabs.some(tab => tab.id === pane.activeTabId) ? pane.activeTabId : tabs[tabs.length - 1]?.id ?? null
        panes.push({ ...pane, tabs, activeTabId })
      }
      claimed.tasks.add(task.id)
      tasks.push({ ...task, panes })
    }
    claimed.streams.add(stream.id)
    streams.push({ ...stream, tasks })
  }
  claimed.projects.add(raw.id)
  const { ssh: _ssh, tunnel: _tunnel, ...rest } = raw
  return { ...rest, streams, host: serverId }
}

/**
 * The desktop's copy of every paired server's projects (plan step 6): one
 * projects source per server, next to the local store.
 *
 * - A server's canonical data lives in its own RevisionStore. This keeps the last
 *   copy seen, refreshed with `load-projects` whenever the server comes online
 *   and on every `projects-updated` it pushes, and cached in
 *   `<configDir>/servers/<id>/projects.json` so an offline server's projects
 *   still render.
 * - A window's save of a server's slice goes over the link as
 *   `save-projects-slice` (the server keeps its own tags, order and pins). A save
 *   to a server that isn't online is refused without sending anything.
 * - Windows see a server's projects with `host` set to its id; the server never does.
 */
export class ServerProjects {
  private readonly entries = new Map<string, Entry>()
  /** Projects a window is saving to a server right now, before the server has them. */
  private readonly pending = new Map<string, Project[]>()
  private readonly listeners = new Set<() => void>()
  private hub: ServerProjectsHub | null = null
  private online = new Set<string>()
  /** Servers by pairing date: on an id two servers claim, the earlier one keeps it. */
  private order: string[] = []
  /** Every server's projects as windows see them (sanitized); null when stale. */
  private view: Map<string, Project[]> | null = null
  /** The drops last logged, per server. */
  private readonly loggedDrops = new Map<string, string>()
  /**
   * Projects moving onto a server from this desktop (Move to a DevTool server),
   * by id, with their server. While this desktop still has its own copy, the
   * server's stays out of every window and out of routing (no collision drop),
   * yet counts as foreign, so the local store keeps its place in the order, its
   * pins and its tags when the local copy goes.
   */
  private readonly incoming = new Map<string, string>()
  /** The server copies of incoming projects, sanitized; part of {@link sanitized}. */
  private handover: Project[] = []
  /**
   * A moved project just showed up in a server's view without the server's
   * revision changing, so a window's save computed before it saw the project
   * would pass the compare-and-swap and drop it. Until this write bumps the
   * revision, window saves to that server wait; after it, such a save is stale
   * and the window replays onto the slice that has the project.
   */
  private readonly barriers = new Map<string, Promise<void>>()

  constructor(private readonly deps: ServerProjectsDeps) {
    this.loadCaches()
  }

  /** Starts following the hub: refreshes servers as they come online, forgets unpaired ones. */
  attach(hub: ServerProjectsHub): void {
    this.hub = hub
    hub.onStateChange((state) => this.onServersState(state))
    this.onServersState(hub.getState())
  }

  /** Every server's slice, for `load-projects` (offline ones from the cache). */
  sources(): ProjectsSources {
    const sources: ProjectsSources = {}
    for (const serverId of this.entries.keys()) sources[serverId] = this.envelope(serverId)
    return sources
  }

  /** Every server project there is (with `host`), the ones being saved and moved here included. */
  foreignProjects(): Project[] {
    const byId = new Map<string, Project>()
    for (const projects of this.sanitized().values()) {
      for (const project of projects) byId.set(project.id, project)
    }
    for (const project of this.handover) if (!byId.has(project.id)) byId.set(project.id, project)
    const local = new Set((this.deps.localProjects?.() ?? []).map(p => p.id))
    for (const [serverId, projects] of this.pending) {
      for (const project of withHost(projects, serverId)) {
        if (!byId.has(project.id) && !local.has(project.id)) byId.set(project.id, project)
      }
    }
    return [...byId.values()]
  }

  /**
   * This desktop's projects changed: a server's ids that now collide with them
   * are dropped (and windows told), ones that no longer do come back.
   */
  localChanged(): void {
    const before = this.view
    this.view = null
    if (!before) return
    const after = this.sanitized()
    let changed = false
    for (const serverId of this.entries.keys()) {
      if (JSON.stringify(before.get(serverId) ?? []) === JSON.stringify(after.get(serverId) ?? [])) continue
      changed = true
      this.deps.broadcast({ source: serverId, ...this.envelope(serverId) })
    }
    if (changed) this.notify()
  }

  isOnline(serverId: string): boolean {
    return this.online.has(serverId)
  }

  /** Runs after any server's projects changed (the router re-indexes). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * A window's compare-and-swap save of `serverId`'s slice. Answers the slice as
   * the server has it on a refusal; an offline server answers `offline` at once.
   */
  async save(serverId: string, clientId: string, payload: { baseRevision: number; data: ProjectsData }, focused = false): Promise<SourceSaveResult> {
    const barrier = this.barriers.get(serverId)
    if (barrier) await barrier
    const hub = this.hub
    if (!hub || !this.online.has(serverId)) return this.offlineRefusal(serverId)
    // A slice holds this server's projects only: a local project (no `host`) or
    // another server's never travels to this one.
    const kept = payload.data.projects.filter(p => p.host === serverId)
    // Its projects this desktop dropped for colliding ids stay on the server.
    const shown = new Set((this.sanitized().get(serverId) ?? []).map(p => p.id))
    const hidden = (this.entries.get(serverId)?.data.projects ?? []).filter(p => isId(p?.id) && !shown.has(p.id) && !kept.some(k => k.id === p.id))
    const projects = [...withoutHost(kept), ...hidden]
    this.pending.set(serverId, withoutHost(kept))
    this.notify()
    try {
      const result = await hub.call(serverId, clientId, 'save-projects-slice', [{
        baseRevision: payload.baseRevision,
        data: { projects }
      }], { focused }) as ProjectsSaveResult
      if (result.ok) return { ok: true, revision: result.revision }
      this.update(serverId, result.revision, result.data)
      return { ok: false, revision: result.revision, data: this.slice(serverId) }
    } catch (err) {
      if (err instanceof LinkError && err.code === LinkErrorCode.ServerOffline) return this.offlineRefusal(serverId)
      throw err
    } finally {
      this.pending.delete(serverId)
      this.notify()
    }
  }

  /**
   * `projectId` is moving from this desktop to `serverId`: until {@link endIncoming},
   * the server's copy is hidden while this desktop still has the project (see `incoming`).
   */
  reserveIncoming(serverId: string, projectId: string): void {
    this.incoming.set(projectId, serverId)
    this.view = null
  }

  /** The move is over (done, or rolled back): the project is an ordinary one of whichever side has it. */
  endIncoming(projectId: string): void {
    const serverId = this.incoming.get(projectId)
    if (!serverId || !this.incoming.delete(projectId)) return
    this.localChanged()
    this.notify()
    const revealed = (this.sanitized().get(serverId) ?? []).some(p => p.id === projectId)
    if (!revealed || !this.online.has(serverId)) return
    const barrier = this.writeProjects(serverId, {})
      .catch((err) => this.deps.log(`serverProjects revealBump server=${serverId} error=${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { if (this.barriers.get(serverId) === barrier) this.barriers.delete(serverId) })
    this.barriers.set(serverId, barrier)
  }

  /**
   * Adds projects to a server's own data (whole, replacing any with the same id)
   * and removes others, with the server's compare-and-swap: a refusal (another
   * desktop or a phone saved first) is retried on the data the server answers
   * with. Resolves once the server has the change; throws when it is offline or
   * keeps refusing, and then nothing changed there.
   */
  async writeProjects(serverId: string, change: { add?: Project[]; remove?: string[] }, attempts = 5): Promise<void> {
    const hub = this.hub
    if (!hub || !this.online.has(serverId)) throw new LinkError(LinkErrorCode.ServerOffline, 'The server is offline')
    const add = withoutHost(change.add ?? [])
    const drop = new Set([...(change.remove ?? []), ...add.map(p => p.id)])
    if (!this.entries.has(serverId)) {
      const sources = await hub.call(serverId, MAIN_CLIENT_ID, 'load-projects') as ProjectsSources
      const own = sources?.[LOCAL_SOURCE]
      if (!own || typeof own.revision !== 'number' || !own.data) throw new Error('The server sent no projects')
      this.update(serverId, own.revision, own.data)
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      const entry = this.entries.get(serverId)!
      const projects = [...entry.data.projects.filter(p => !drop.has(p?.id)), ...add]
      const result = await hub.call(serverId, MAIN_CLIENT_ID, 'save-projects-slice', [{
        baseRevision: entry.revision,
        data: { projects }
      }]) as ProjectsSaveResult
      if (result.ok) {
        // Its `projects-updated` usually came first (one link, in order); else this is the news.
        if ((this.entries.get(serverId)?.revision ?? -Infinity) < result.revision) {
          this.update(serverId, result.revision, { ...entry.data, projects })
        }
        return
      }
      this.update(serverId, result.revision, result.data)
    }
    throw new Error('The server kept refusing the change. Try again.')
  }

  /** A server pushed `projects-updated` (its own source, `local` there). */
  handleUpdate(serverId: string, update: unknown): void {
    const envelope = update as Partial<SourceEnvelope> | null
    if (!envelope || typeof envelope.revision !== 'number' || !envelope.data || !Array.isArray(envelope.data.projects)) {
      this.deps.log(`serverProjects badUpdate server=${serverId}`)
      return
    }
    this.update(serverId, envelope.revision, envelope.data)
  }

  /** Loads the server's projects now (it just came online). */
  async refresh(serverId: string): Promise<void> {
    const hub = this.hub
    if (!hub) return
    try {
      const sources = await hub.call(serverId, MAIN_CLIENT_ID, 'load-projects') as ProjectsSources
      const own = sources?.[LOCAL_SOURCE]
      if (!own || typeof own.revision !== 'number' || !own.data) throw new Error('no projects in the answer')
      this.update(serverId, own.revision, own.data)
    } catch (err) {
      this.deps.log(`serverProjects refresh server=${serverId} error=${err instanceof Error ? err.message : String(err)}`)
      // Online all the same: windows may edit its cached projects (a stale save is refused and replayed).
      if (this.entries.has(serverId) && this.online.has(serverId)) this.deps.broadcast({ source: serverId, ...this.envelope(serverId) })
    }
  }

  /** The server was unpaired: its projects leave every window, and the cache goes. */
  forget(serverId: string): void {
    const had = this.entries.delete(serverId)
    this.online.delete(serverId)
    this.view = null
    if (SERVER_ID_RE.test(serverId)) {
      try {
        fs.rmSync(this.cacheDir(serverId), { recursive: true, force: true })
      } catch {
        // Best effort: an unreadable cache of a forgotten server is never read again.
      }
    }
    if (!had) return
    this.notify()
    this.deps.broadcast({ source: serverId, revision: 0, data: emptyProjectsData(), offline: true })
  }

  // ---- internals ------------------------------------------------------------------

  private onServersState(state: ServersState): void {
    const order = [...state.servers].sort((a, b) => a.pairedAt - b.pairedAt).map(s => s.id)
    if (order.join('\u0000') !== this.order.join('\u0000')) {
      this.order = order
      this.view = null
    }
    const paired = new Set(state.servers.map(s => s.id))
    for (const serverId of [...this.entries.keys()]) {
      if (!paired.has(serverId)) this.forget(serverId)
    }
    for (const server of state.servers) {
      const nowOnline = server.state === 'online'
      const wasOnline = this.online.has(server.id)
      if (nowOnline === wasOnline) continue
      if (nowOnline) {
        this.online.add(server.id)
        void this.refresh(server.id)
      } else {
        this.online.delete(server.id)
        // Windows grey its projects out and refuse edits until it's back.
        if (this.entries.has(server.id)) this.deps.broadcast({ source: server.id, ...this.envelope(server.id) })
      }
    }
  }

  private update(serverId: string, revision: number, data: ProjectsData): void {
    const entry: Entry = { revision, data: { ...emptyProjectsData(), ...data, projects: withoutHost(data.projects) } }
    this.entries.set(serverId, entry)
    this.view = null
    this.writeCache(serverId, entry)
    this.notify()
    this.deps.broadcast({ source: serverId, ...this.envelope(serverId) })
  }

  private envelope(serverId: string): SourceEnvelope {
    const entry = this.entries.get(serverId)
    return {
      revision: entry?.revision ?? 0,
      data: this.slice(serverId),
      ...(this.online.has(serverId) ? {} : { offline: true })
    }
  }

  /** The server's slice as windows see it. */
  private slice(serverId: string): ProjectsData {
    return { ...emptyProjectsData(), projects: this.sanitized().get(serverId) ?? [] }
  }

  /**
   * Every server's projects, sanitized (see `sanitizeProject`): ids this desktop
   * owns are claimed first, then each server's in pairing order.
   */
  private sanitized(): Map<string, Project[]> {
    if (this.view) return this.view
    const local = this.deps.localProjects?.() ?? []
    const localIds = new Set(local.map(p => p.id))
    const claimed = claimedBy(local)
    const known = this.order.filter(id => this.entries.has(id))
    const rest = [...this.entries.keys()].filter(id => !known.includes(id)).sort()
    const view = new Map<string, Project[]>()
    const handover: Project[] = []
    for (const serverId of [...known, ...rest]) {
      const dropped: string[] = []
      const projects: Project[] = []
      for (const raw of this.entries.get(serverId)!.data.projects) {
        if (raw && isId(raw.id) && this.incoming.get(raw.id) === serverId && localIds.has(raw.id)) {
          // Moving here, and this desktop still has it: not a collision, just not yet.
          const copy = sanitizeProject(raw, serverId, claimedBy([]), [])
          if (copy) handover.push(copy)
          continue
        }
        const project = sanitizeProject(raw, serverId, claimed, dropped)
        if (project) projects.push(project)
      }
      view.set(serverId, projects)
      const key = dropped.join(',')
      if (key !== (this.loggedDrops.get(serverId) ?? '')) {
        this.loggedDrops.set(serverId, key)
        if (key) this.deps.log(`serverProjects dropped server=${serverId} reason=id-collision ids=${key.slice(0, 400)}`)
      }
    }
    this.view = view
    this.handover = handover
    return view
  }

  private offlineRefusal(serverId: string): SourceSaveResult {
    return { ok: false, offline: true, revision: this.entries.get(serverId)?.revision ?? 0, data: this.slice(serverId) }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (err) {
        this.deps.log(`serverProjects listener error=${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private cacheDir(serverId: string): string {
    return path.join(this.deps.configDir, 'servers', serverId)
  }

  private writeCache(serverId: string, entry: Entry): void {
    if (!SERVER_ID_RE.test(serverId)) return
    try {
      fs.mkdirSync(this.cacheDir(serverId), { recursive: true })
      atomicWriteFileSync(path.join(this.cacheDir(serverId), 'projects.json'), JSON.stringify({ version: 1, ...entry }))
    } catch (err) {
      this.deps.log(`serverProjects cacheWrite server=${serverId} error=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private loadCaches(): void {
    const root = path.join(this.deps.configDir, 'servers')
    let names: string[]
    try {
      names = fs.readdirSync(root)
    } catch {
      return
    }
    for (const serverId of names) {
      if (!SERVER_ID_RE.test(serverId)) continue
      const read = readJsonRecord(path.join(root, serverId, 'projects.json'))
      if (read.kind !== 'ok') continue
      const { revision, data } = read.data as { revision?: unknown; data?: Partial<ProjectsData> }
      if (typeof revision !== 'number' || !data || !Array.isArray(data.projects)) continue
      this.entries.set(serverId, { revision, data: { ...emptyProjectsData(), ...data, projects: withoutHost(data.projects as Project[]) } })
    }
  }
}

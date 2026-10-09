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
import type { Project, ProjectsData, ProjectsSaveResult } from '../../shared/types'
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

  /** Every server project there is (with `host`), the ones being saved included. */
  foreignProjects(): Project[] {
    const byId = new Map<string, Project>()
    for (const [serverId, entry] of this.entries) {
      for (const project of withHost(entry.data.projects, serverId)) byId.set(project.id, project)
    }
    for (const [serverId, projects] of this.pending) {
      for (const project of withHost(projects, serverId)) if (!byId.has(project.id)) byId.set(project.id, project)
    }
    return [...byId.values()]
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
    const hub = this.hub
    if (!hub || !this.online.has(serverId)) return this.offlineRefusal(serverId)
    // A slice holds this server's projects only; another host's never travel here.
    const projects = payload.data.projects.filter(p => !p.host || p.host === serverId)
    this.pending.set(serverId, withoutHost(projects))
    this.notify()
    try {
      const result = await hub.call(serverId, clientId, 'save-projects-slice', [{
        baseRevision: payload.baseRevision,
        data: { projects: withoutHost(projects) }
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
    const entry = this.entries.get(serverId)
    return { ...emptyProjectsData(), projects: withHost(entry?.data.projects ?? [], serverId) }
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

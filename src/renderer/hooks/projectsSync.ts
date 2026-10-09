import type { ProjectsData } from '../../shared/types'
import {
  LOCAL_SOURCE,
  changedSources,
  isOfflineRefusal,
  mergeSources,
  orderServerProjects,
  sliceOf,
  sourcesIn,
  withSlice,
  type ProjectsSources,
  type ProjectsUpdate,
  type SourceSaveResult
} from '../../shared/projects-sources'
import { RevisionSyncClient, type Updater } from './revisionSync'

export interface ProjectsSyncOptions {
  /** `save-projects` for one source. */
  save: (source: string, payload: { baseRevision: number; data: ProjectsData }) => Promise<SourceSaveResult>
  /** The window's merged data right now (every mutation already applied). */
  getData: () => ProjectsData
  /** Change the window's merged data (React state and `getData` alike). */
  apply: (change: (prev: ProjectsData) => ProjectsData) => void
  /** Retries exhausted, or the IPC itself threw: shown to the user. */
  onError: (message: string) => void
  /** A save to an offline server was refused and that server's projects rolled back. */
  onOffline: (source: string) => void
  /** Applied to canonical data from main before it is adopted (lifetime stats backfill). */
  transform?: (data: ProjectsData) => ProjectsData
}

class SourceOfflineError extends Error {
  constructor(source: string) {
    super(`${source} is offline`)
    this.name = 'SourceOfflineError'
  }
}

/**
 * The renderer half of the projects' compare-and-swap, with one
 * {@link RevisionSyncClient} per source (this desktop, each DevTool server;
 * plan step 0 note 3). The window works on the merged data; a mutation that
 * changes several sources' slices (adding a server project also adds it to the
 * local `projectOrder`) records a slice updater on each of their clients, so a
 * refusal from one source replays only that source's slice, and no updater is
 * ever applied twice to one store.
 */
export class ProjectsSync {
  private readonly clients = new Map<string, RevisionSyncClient<ProjectsData>>()
  /** Each source's slice as last sent or adopted, serialized: what the save effect compares against. */
  private readonly lastSaved = new Map<string, string>()
  private readonly offline = new Set<string>()
  private readonly transform: (data: ProjectsData) => ProjectsData

  constructor(private readonly options: ProjectsSyncOptions) {
    this.transform = options.transform ?? ((data) => data)
  }

  /** The client of one source, made on first use. */
  client(source: string): RevisionSyncClient<ProjectsData> {
    let client = this.clients.get(source)
    if (client) return client
    let offlineRefused = false
    client = new RevisionSyncClient<ProjectsData>({
      save: async (payload) => {
        offlineRefused = false
        const result = await this.options.save(source, payload)
        if (isOfflineRefusal(result)) {
          offlineRefused = true
          this.rollBack(source, result.data)
          throw new SourceOfflineError(source)
        }
        return result
      },
      onRebase: (slice) => this.adopt(source, slice),
      onError: (message) => {
        // A refused save to an offline server was rolled back and reported already.
        if (offlineRefused) return
        this.options.onError(message)
      }
    })
    this.clients.set(source, client)
    return client
  }

  isOffline(source: string): boolean {
    return source !== LOCAL_SOURCE && this.offline.has(source)
  }

  /**
   * The initial load: every source's revision, and the merged data to start
   * from. The caller then marks it saved ({@link markSaved}).
   */
  hydrate(sources: ProjectsSources): ProjectsData {
    const slices: Record<string, ProjectsData> = {}
    for (const [source, envelope] of Object.entries(sources)) {
      this.client(source).hydrate(envelope.revision)
      this.setOffline(source, envelope.offline === true)
      slices[source] = this.transform(envelope.data)
    }
    return mergeSources(slices)
  }

  /** Every source's slice of `data` counts as saved (what was loaded). */
  markSaved(data: ProjectsData): void {
    for (const source of new Set([...sourcesIn(data), ...this.clients.keys()])) {
      this.lastSaved.set(source, JSON.stringify(sliceOf(data, source)))
    }
  }

  /**
   * A mutation of the merged data. Each source whose slice it changes gets the
   * updater, as a slice updater, for replay. Refused (nothing recorded) when it
   * would change an offline server's projects: those sources are returned.
   */
  record(updater: Updater<ProjectsData>): { refused: string[] } | { refused: null } {
    const prev = this.options.getData()
    const next = updater(prev)
    const changed = changedSources(prev, next)
    const refused = changed.filter(source => this.isOffline(source))
    if (refused.length > 0) return { refused }
    for (const source of changed) {
      this.client(source).enqueue(slice => sliceOf(updater(withSlice(this.options.getData(), source, slice)), source))
    }
    return { refused: null }
  }

  /** Main's canonical slice of one source (`projects-updated`). */
  receive(update: ProjectsUpdate): void {
    const { source, revision } = update
    if (typeof source !== 'string' || !update.data) return
    this.setOffline(source, update.offline === true)
    const canonical = this.transform(update.data)
    const client = this.client(source)
    // Compare the inner data: the revision alone would make every broadcast (our
    // own save echoing back included) look like news.
    if (JSON.stringify(canonical) === this.lastSaved.get(source)) {
      // Mid-save the acknowledgement carries the authoritative revision; adopting
      // one from an echo would let a stale base slip past the compare-and-swap.
      if (!client.isSaving()) client.hydrate(revision)
      return
    }
    const next = client.applyBroadcast(revision, canonical)
    if (next === null) return
    // Marked saved, so the save effect doesn't re-send state we were just handed;
    // anything replayed on top is sent explicitly.
    this.adopt(source, next)
    if (client.hasPending()) client.requestSave(next)
  }

  /**
   * The save effect: send every source whose slice differs from what it last
   * saved. Servers go before this desktop, so main knows a new server project
   * by the time the local order naming it arrives. Offline servers wait.
   */
  saveChanged(data: ProjectsData): void {
    const sources = [...new Set([...sourcesIn(data), ...this.clients.keys()])]
      .sort((a, b) => (a === LOCAL_SOURCE ? 1 : 0) - (b === LOCAL_SOURCE ? 1 : 0))
    for (const source of sources) {
      if (this.isOffline(source)) continue
      const slice = sliceOf(data, source)
      const serialized = JSON.stringify(slice)
      if (serialized === this.lastSaved.get(source)) continue
      this.lastSaved.set(source, serialized)
      this.client(source).requestSave(slice)
    }
  }

  /** Resolves once no source has a save in flight. Tests await this. */
  async settled(): Promise<void> {
    await Promise.all([...this.clients.values()].map(client => client.settled()))
  }

  private setOffline(source: string, offline: boolean): void {
    if (source === LOCAL_SOURCE) return
    if (offline) this.offline.add(source)
    else this.offline.delete(source)
  }

  /** Take `slice` as the source's saved state, in the window's data. */
  private adopt(source: string, slice: ProjectsData): void {
    this.lastSaved.set(source, JSON.stringify(slice))
    this.options.apply(prev => orderServerProjects(withSlice(prev, source, slice)))
  }

  /** An offline server refused: its unsent changes are dropped and its cached slice comes back. */
  private rollBack(source: string, cached: ProjectsData): void {
    this.offline.add(source)
    this.client(source).abandon()
    this.adopt(source, this.transform(cached))
    this.options.onOffline(source)
  }
}

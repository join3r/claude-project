import type { Project, ProjectsData, RevisionSaveResult } from './types'

/**
 * Projects come from more than one store: this desktop's own (`local`) and each
 * paired DevTool server's (keyed by its id). Every store keeps its own revision,
 * so the renderer runs one compare-and-swap client per source and a save goes to
 * one store only (plan step 0 note 3): a refusal replays only that source's slice.
 *
 * - The local slice is the projects without `host`, plus `tags`, `projectOrder`
 *   and `pinnedItems` (which may name server projects too).
 * - A server's slice is that server's projects, each with `host` set to its id.
 *   The other fields are empty: the server keeps its own, which a desktop never sends.
 */

export const LOCAL_SOURCE = 'local'

/** One source's canonical slice. `offline`: a server the desktop can't reach; this is its cached copy. */
export interface SourceEnvelope {
  revision: number
  data: ProjectsData
  offline?: boolean
}

/** What `load-projects` answers: every source there is, by name. */
export type ProjectsSources = Record<string, SourceEnvelope>

/** The `projects-updated` push: one source's new canonical slice. */
export interface ProjectsUpdate extends SourceEnvelope {
  source: string
}

/** A refused save to a server that is offline: the slice is the cached one, and nothing was sent. */
export type SourceSaveResult = RevisionSaveResult<ProjectsData> | { ok: false; offline: true; revision: number; data: ProjectsData }

export function isOfflineRefusal(result: SourceSaveResult): result is { ok: false; offline: true; revision: number; data: ProjectsData } {
  return !result.ok && 'offline' in result && result.offline === true
}

/** The source a project is saved to. */
export function projectsSourceOf(project: Pick<Project, 'host'>): string {
  return project.host ?? LOCAL_SOURCE
}

export function emptyProjectsData(): ProjectsData {
  return { projects: [], tags: [], projectOrder: [], pinnedItems: [] }
}

/** The part of the merged data that `source` stores. */
export function sliceOf(data: ProjectsData, source: string): ProjectsData {
  if (source === LOCAL_SOURCE) {
    return {
      projects: data.projects.filter(p => !p.host),
      tags: data.tags ?? [],
      projectOrder: data.projectOrder ?? [],
      pinnedItems: data.pinnedItems ?? []
    }
  }
  return { projects: data.projects.filter(p => p.host === source), tags: [], projectOrder: [], pinnedItems: [] }
}

/** `data` with `source`'s part replaced by `slice` (a server's projects get its `host`). */
export function withSlice(data: ProjectsData, source: string, slice: ProjectsData): ProjectsData {
  if (source === LOCAL_SOURCE) {
    return {
      ...data,
      projects: [...slice.projects.filter(p => !p.host), ...data.projects.filter(p => p.host)],
      tags: slice.tags ?? [],
      projectOrder: slice.projectOrder ?? [],
      pinnedItems: slice.pinnedItems ?? []
    }
  }
  return {
    ...data,
    projects: [...data.projects.filter(p => p.host !== source), ...withHost(slice.projects, source)]
  }
}

/** Every source with a project in `data`, local first. */
export function sourcesIn(data: ProjectsData): string[] {
  const sources = [LOCAL_SOURCE]
  for (const project of data.projects) {
    if (project.host && !sources.includes(project.host)) sources.push(project.host)
  }
  return sources
}

/** The sources whose slice differs between `prev` and `next`. */
export function changedSources(prev: ProjectsData, next: ProjectsData): string[] {
  const sources = new Set([...sourcesIn(prev), ...sourcesIn(next)])
  return [...sources].filter(source => JSON.stringify(sliceOf(prev, source)) !== JSON.stringify(sliceOf(next, source)))
}

/**
 * Server projects missing from the local `projectOrder` (added by another desktop,
 * or before this one heard of them) go at the end, so the tree lists them.
 */
export function orderServerProjects(data: ProjectsData): ProjectsData {
  const order = data.projectOrder ?? []
  const listed = new Set(order)
  const missing = data.projects.filter(p => p.host && !listed.has(p.id)).map(p => p.id)
  if (missing.length === 0) return data
  return { ...data, projectOrder: [...order, ...missing] }
}

/** The merged view the renderer works on: the local slice, every server's projects, ordered. */
export function mergeSources(sources: Record<string, ProjectsData>): ProjectsData {
  let data = sources[LOCAL_SOURCE] ? sliceOf(sources[LOCAL_SOURCE], LOCAL_SOURCE) : emptyProjectsData()
  for (const [source, slice] of Object.entries(sources)) {
    if (source === LOCAL_SOURCE) continue
    data = withSlice(data, source, slice)
  }
  return orderServerProjects(data)
}

/** A server's projects as the desktop shows them: `host` set to its id. */
export function withHost(projects: readonly Project[], serverId: string): Project[] {
  return projects.map(p => (p.host === serverId ? p : { ...p, host: serverId }))
}

/** A server's projects as it stores them: no `host`, which only means something to a desktop. */
export function withoutHost(projects: readonly Project[]): Project[] {
  return projects.map(p => {
    if (p.host === undefined) return p
    const { host: _host, ...rest } = p
    return rest
  })
}

/**
 * A server takes a desktop's slice (its projects) into its own data: the server's
 * tags, projectOrder and pinnedItems are its own (the phone reads them), so they
 * stay; storage then adds new projects to its order and drops pins of gone ones.
 */
export function mergeProjectsSlice(current: ProjectsData, projects: readonly Project[]): ProjectsData {
  return { ...current, projects: withoutHost(projects) }
}

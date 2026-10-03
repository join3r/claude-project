import fs from 'fs'
import path from 'path'
import {
  AppConfig,
  coerceWindowsTerminal,
  DEFAULT_CONFIG,
  ProjectsData,
  createDefaultWindowSessionState,
  createDefaultWindowViewState,
  isSpentEphemeralProject,
  normalizePinnedItems,
  pruneUnusedTags,
  reconcileWindowViewState,
  type PersistedWindowState,
  type Project,
  type SidebarTab,
  type Tag,
  type TaskViewState,
  type WindowGeometry,
  type WindowSessionState,
  type WindowViewState
} from '../shared/types'
import { normalizeMobileConfig } from '../shared/mobile'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

const EMPTY_PROJECTS: () => ProjectsData = () => ({ projects: [], tags: [], projectOrder: [], pinnedItems: [] })

/**
 * Write `data` to `target` so a crash leaves either the old file or the new one,
 * never a truncated mix: write a sibling temp file, fsync it, rename over the target.
 * Same directory so the rename stays on one filesystem (and is atomic on POSIX).
 */
export function atomicWriteFileSync(target: string, data: string, mode?: number): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  let fd: number | null = null
  try {
    // `mode` applies from creation, so a secret is never briefly world-readable.
    fd = fs.openSync(tmp, 'w', mode)
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    renameWithRetry(tmp, target)
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* already failing */ }
    }
    try { fs.unlinkSync(tmp) } catch { /* may not exist */ }
    throw err
  }
  if (process.platform !== 'win32') {
    // Persist the rename itself. Best effort: some filesystems refuse fsync on a dir.
    try {
      const dirFd = fs.openSync(path.dirname(target), 'r')
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
    } catch { /* ignore */ }
  }
}

function renameWithRetry(from: string, to: string): void {
  // On Windows a reader (antivirus, indexer) holding the target briefly makes the
  // replace fail with EPERM/EBUSY; a short retry clears nearly all of those.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        throw err
      }
      const until = Date.now() + 20 * (attempt + 1)
      while (Date.now() < until) { /* brief sync backoff */ }
    }
  }
}

type JsonReadResult =
  | { kind: 'missing' }
  | { kind: 'ok'; raw: string; data: Record<string, unknown> }
  | { kind: 'corrupt'; error: unknown }

/** Missing is a normal first run; anything else that fails is a file we must not overwrite blindly. */
function readJsonRecord(file: string): JsonReadResult {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'corrupt', error: err }
  }
  try {
    const data = JSON.parse(raw) as unknown
    if (!isRecord(data) || Array.isArray(data)) {
      return { kind: 'corrupt', error: new Error('top-level JSON value is not an object') }
    }
    return { kind: 'ok', raw, data }
  } catch (err) {
    return { kind: 'corrupt', error: err }
  }
}

function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Rename a bad file out of the way so nothing later overwrites it. Returns the new path, or null. */
function quarantine(file: string): string | null {
  const dest = `${file}.corrupt-${fileStamp()}`
  try {
    fs.renameSync(file, dest)
    return dest
  } catch (err) {
    console.error(`[storage] could not move unreadable ${file} aside:`, err)
    return null
  }
}

export class Storage {
  private configPath: string
  private projectsPath: string
  private windowSessionPath: string
  private backupsDir: string

  constructor(dir: string) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this.configPath = path.join(dir, 'config.json')
    this.projectsPath = path.join(dir, 'projects.json')
    this.windowSessionPath = path.join(dir, 'window-session.json')
    this.backupsDir = path.join(dir, 'backups')
  }

  /** Snapshot file names, oldest first (ISO timestamps sort lexically). */
  private listProjectBackups(): string[] {
    try {
      return fs
        .readdirSync(this.backupsDir)
        .filter(f => f.startsWith('projects-') && f.endsWith('.json'))
        .sort()
    } catch {
      return []
    }
  }

  /**
   * Rotating snapshot of projects.json — recovery net if another instance clobbers it,
   * and the only thing standing behind a silent idle-cleanup deletion.
   *
   * Returns whether a snapshot now exists on disk. Callers that merely want a safety
   * net (startup) ignore it; a caller that is about to delete the user's tasks must
   * not proceed on a `false` (finding #9). "Nothing to copy yet" counts as success:
   * there is no state to lose.
   */
  backupProjectsOnStartup(keep = 10): boolean {
    try {
      const current = readJsonRecord(this.projectsPath)
      if (current.kind === 'missing') return true
      // Never snapshot a file we cannot parse: it would push good snapshots out of
      // the rotation, and it is useless as a restore point.
      if (current.kind === 'corrupt') return false
      fs.mkdirSync(this.backupsDir, { recursive: true })
      const existing = this.listProjectBackups()
      const newest = existing[existing.length - 1]
      if (newest) {
        try {
          if (fs.readFileSync(path.join(this.backupsDir, newest), 'utf-8') === current.raw) {
            // Identical to the newest snapshot: it already covers us, and adding a
            // duplicate would only rotate an older, distinct one out.
            return true
          }
        } catch {
          // Unreadable newest snapshot: fall through and write a fresh one.
        }
      }
      const snapshotPath = path.join(this.backupsDir, `projects-${fileStamp()}.json`)
      atomicWriteFileSync(snapshotPath, current.raw)
      try {
        for (const f of this.listProjectBackups().slice(0, -keep)) {
          fs.unlinkSync(path.join(this.backupsDir, f))
        }
      } catch {
        // The snapshot is written; failing to prune old ones does not invalidate it.
      }
      return fs.existsSync(snapshotPath)
    } catch {
      return false
    }
  }

  loadConfig(): AppConfig {
    const result = readJsonRecord(this.configPath)
    if (result.kind === 'missing') return { ...DEFAULT_CONFIG }
    if (result.kind === 'corrupt') {
      // Keep the user's settings file for manual recovery instead of letting the
      // next save overwrite it with defaults.
      const movedTo = quarantine(this.configPath)
      console.error(
        `[storage] config.json is unreadable (${String(result.error)}); ` +
        (movedTo ? `moved to ${movedTo}; ` : '') + 'using default settings'
      )
      return { ...DEFAULT_CONFIG }
    }
    try {
      const parsed = result.data
      // Retired keys: the folder tree's collapse state, and the new-task auto-open
      // setting the empty task's prompt box replaced.
      const { collapsedFolderIds: _legacy, newTaskAutoOpen: _autoOpen, ...rest } = parsed
      const config = { ...DEFAULT_CONFIG, ...rest } as AppConfig
      config.windowsTerminal = coerceWindowsTerminal(config.windowsTerminal)
      const savedEditors = (rest.externalEditors && typeof rest.externalEditors === 'object')
        ? rest.externalEditors as { editors?: unknown; defaultId?: unknown }
        : null
      config.externalEditors = {
        editors: Array.isArray(savedEditors?.editors) ? savedEditors.editors as AppConfig['externalEditors']['editors'] : [],
        defaultId: typeof savedEditors?.defaultId === 'string' ? savedEditors.defaultId : null
      }
      config.mobile = normalizeMobileConfig(rest.mobile)
      return config
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  saveConfig(config: AppConfig): void {
    atomicWriteFileSync(this.configPath, JSON.stringify(config, null, 2))
  }

  /**
   * A missing file is a fresh start. An unreadable or unparseable one is not: the
   * caller adopts whatever this returns and the next save replaces the file, so
   * returning empty data here would wipe every project. Instead the bad file is
   * moved aside and the newest parseable startup snapshot is restored.
   */
  loadProjects(): ProjectsData {
    const result = readJsonRecord(this.projectsPath)
    if (result.kind === 'missing') return EMPTY_PROJECTS()
    if (result.kind === 'ok') {
      try {
        return Storage.normalizeProjectsData(result.data)
      } catch (err) {
        return this.recoverProjects(err)
      }
    }
    return this.recoverProjects(result.error)
  }

  private recoverProjects(error: unknown): ProjectsData {
    const movedTo = quarantine(this.projectsPath)
    console.error(
      `[storage] projects.json is unreadable (${String(error)})` + (movedTo ? `; moved to ${movedTo}` : '')
    )
    for (const name of this.listProjectBackups().reverse()) {
      const backupPath = path.join(this.backupsDir, name)
      const backup = readJsonRecord(backupPath)
      if (backup.kind !== 'ok') continue
      let data: ProjectsData
      try {
        data = Storage.normalizeProjectsData(backup.data)
      } catch {
        continue
      }
      try {
        atomicWriteFileSync(this.projectsPath, backup.raw)
      } catch (err) {
        // Still return the data: the next regular save will write it.
        console.error('[storage] could not write restored projects.json:', err)
      }
      console.error(`[storage] restored projects.json from backup ${backupPath}`)
      return data
    }
    console.error('[storage] no usable projects backup found; starting with empty projects')
    return EMPTY_PROJECTS()
  }

  static normalizeProjectsData(data: Record<string, unknown>): ProjectsData {
    const allProjects: Project[] = Array.isArray(data.projects) ? data.projects : []
    // A hidden ad-hoc project is only ever a home for tasks; once the last real
    // one is gone it has no reason to exist. Dropping it here catches every
    // writer at once — including main's idle-cleanup sweep, which removes tasks
    // without going through the renderer. Safe because such a project is always
    // created in the same write as its first task.
    const projects = allProjects.filter(p => !isSpentEphemeralProject(p))
    const projectIds = new Set(projects.map(p => p.id))
    const tagIds = new Set(
      (Array.isArray(data.tags) ? data.tags as Tag[] : [])
        .filter((t): t is Tag => typeof t?.id === 'string' && typeof t?.name === 'string')
        .map(t => t.id)
    )

    const tags: Tag[] = Array.isArray(data.tags)
      ? (data.tags as Tag[]).filter(
          (t): t is Tag => typeof t?.id === 'string' && typeof t?.name === 'string' && tagIds.has(t.id)
        )
      : []

    const projectOrder: string[] = Array.isArray(data.projectOrder)
      ? data.projectOrder.filter((id): id is string => typeof id === 'string' && projectIds.has(id))
      : projects.map(p => p.id)

    const orderSet = new Set(projectOrder)
    for (const p of projects) {
      if (!orderSet.has(p.id)) {
        projectOrder.push(p.id)
        orderSet.add(p.id)
      }
    }

    const normalizedProjects = projects.map(project => ({
      ...project,
      tagIds: (project.tagIds ?? []).filter(id => tagIds.has(id))
    }))

    const now = Date.now()
    for (const project of normalizedProjects) {
      if (!Array.isArray(project.tasks)) continue
      for (const task of project.tasks) {
        const legacy = (task as { lastFocusedAt?: unknown }).lastFocusedAt
        if (typeof legacy === 'number' && task.lastInteractedAt === undefined) {
          task.lastInteractedAt = legacy
        }
        delete (task as { lastFocusedAt?: unknown }).lastFocusedAt
        // A task with no activity stamp at all reads as infinitely idle, which would make it
        // the first thing idle-cleanup deletes. Start its clock now instead: nothing should
        // be deleted on the basis of data we never recorded.
        if (task.lastInteractedAt === undefined && task.inbox?.eventAt === undefined) {
          task.lastInteractedAt = now
        }
      }
    }

    return pruneUnusedTags({
      projects: normalizedProjects,
      tags,
      projectOrder,
      pinnedItems: normalizePinnedItems(data.pinnedItems, normalizedProjects)
    })
  }

  saveProjects(data: ProjectsData): void {
    const normalized = Storage.normalizeProjectsData(data as unknown as Record<string, unknown>)
    atomicWriteFileSync(this.projectsPath, JSON.stringify(normalized, null, 2))
  }

  /**
   * `defaultSidebarTab` only fills in windows persisted before the field existed —
   * a window that recorded a tab keeps it, the way it kept its geometry.
   */
  loadWindowSession(projectsData: ProjectsData, defaultSidebarTab: SidebarTab = 'projects'): WindowSessionState {
    try {
      const raw = fs.readFileSync(this.windowSessionPath, 'utf-8')
      const data = JSON.parse(raw)
      return Storage.normalizeWindowSessionData(data, projectsData, defaultSidebarTab)
    } catch {
      return createDefaultWindowSessionState()
    }
  }

  saveWindowSession(data: WindowSessionState): void {
    atomicWriteFileSync(this.windowSessionPath, JSON.stringify(data, null, 2))
  }

  static normalizeWindowSessionData(
    data: unknown,
    projectsData: ProjectsData,
    defaultSidebarTab: SidebarTab = 'projects'
  ): WindowSessionState {
    if (!isRecord(data) || !Array.isArray(data.windows)) {
      return createDefaultWindowSessionState()
    }

    const tagIds = new Set(projectsData.tags.map(tag => tag.id))
    const windows = data.windows
      .map((entry) => Storage.normalizePersistedWindowState(entry, projectsData.projects, tagIds, defaultSidebarTab))
      .filter((entry): entry is PersistedWindowState => entry !== null)

    return { windows }
  }

  private static normalizePersistedWindowState(
    value: unknown,
    projects: Project[],
    tagIds: Set<string>,
    defaultSidebarTab: SidebarTab
  ): PersistedWindowState | null {
    if (!isRecord(value)) return null

    const geometry = Storage.normalizeWindowGeometry(value.geometry)
    if (!geometry) return null

    const viewState = Storage.normalizeWindowViewState(value.viewState, projects, tagIds, defaultSidebarTab)
    return { geometry, viewState }
  }

  private static normalizeWindowGeometry(value: unknown): WindowGeometry | null {
    if (!isRecord(value)) return null
    const { x, y, width, height, isMaximized } = value
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
      return null
    }
    if (width <= 0 || height <= 0) {
      return null
    }
    return {
      x,
      y,
      width,
      height,
      isMaximized: typeof isMaximized === 'boolean' ? isMaximized : false
    }
  }

  private static normalizeWindowViewState(
    value: unknown,
    projects: Project[],
    tagIds: Set<string>,
    defaultSidebarTab: SidebarTab
  ): WindowViewState {
    if (!isRecord(value)) {
      return { ...createDefaultWindowViewState(), sidebarTab: defaultSidebarTab }
    }

    const projectIds = new Set(projects.map(p => p.id))
    const taskStates = Storage.normalizeTaskStates(value.taskStates)
    const legacySelected = Array.isArray(value.selectedTagIds)
      ? value.selectedTagIds
      : []
    const selectedTagIds = legacySelected.filter(
      (id): id is string => typeof id === 'string' && tagIds.has(id)
    )
    const expandedProjectIds = Array.isArray(value.expandedProjectIds)
      ? value.expandedProjectIds.filter((id): id is string => typeof id === 'string' && projectIds.has(id))
      : []
    const fileBrowserActiveTab = (value.fileBrowserActiveTab === 'files' || value.fileBrowserActiveTab === 'git' || value.fileBrowserActiveTab === 'notes')
      ? value.fileBrowserActiveTab
      : 'files'

    return reconcileWindowViewState(
      {
        selectedProjectId: typeof value.selectedProjectId === 'string' ? value.selectedProjectId : null,
        selectedTaskId: typeof value.selectedTaskId === 'string' ? value.selectedTaskId : null,
        selectedTagIds,
        expandedProjectIds,
        taskStates,
        fileBrowserOpen: typeof value.fileBrowserOpen === 'boolean' ? value.fileBrowserOpen : false,
        fileBrowserWidth: isFiniteNumber(value.fileBrowserWidth) ? value.fileBrowserWidth : 250,
        fileBrowserActiveTab,
        sidebarWidth: isFiniteNumber(value.sidebarWidth) ? value.sidebarWidth : 240,
        sidebarProjectsCollapsed: typeof value.sidebarProjectsCollapsed === 'boolean' ? value.sidebarProjectsCollapsed : false,
        sidebarTab: (value.sidebarTab === 'inbox' || value.sidebarTab === 'projects')
          ? value.sidebarTab
          : defaultSidebarTab
      },
      projects,
      tagIds
    )
  }

  private static normalizeTaskStates(value: unknown): Record<string, TaskViewState> {
    if (!isRecord(value)) return {}

    const taskStates: Record<string, TaskViewState> = {}
    for (const [taskId, taskState] of Object.entries(value)) {
      if (!isRecord(taskState)) continue
      const activeTab = isRecord(taskState.activeTab) ? taskState.activeTab : {}
      const fileBrowserActiveTab = (taskState.fileBrowserActiveTab === 'files'
        || taskState.fileBrowserActiveTab === 'git'
        || taskState.fileBrowserActiveTab === 'notes')
        ? taskState.fileBrowserActiveTab
        : undefined
      taskStates[taskId] = {
        activeTab: {
          left: typeof activeTab.left === 'string' ? activeTab.left : null,
          right: typeof activeTab.right === 'string' ? activeTab.right : null
        },
        splitOpen: typeof taskState.splitOpen === 'boolean' ? taskState.splitOpen : false,
        splitRatio: isFiniteNumber(taskState.splitRatio) ? taskState.splitRatio : 0.5,
        ...(typeof taskState.fileBrowserOpen === 'boolean' ? { fileBrowserOpen: taskState.fileBrowserOpen } : {}),
        ...(fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab } : {})
      }
    }

    return taskStates
  }
}

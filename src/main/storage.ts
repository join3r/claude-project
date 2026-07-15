import fs from 'fs'
import path from 'path'
import {
  AppConfig,
  DEFAULT_CONFIG,
  ProjectsData,
  createDefaultWindowSessionState,
  createDefaultWindowViewState,
  normalizePinnedItems,
  pruneUnusedTags,
  reconcileWindowViewState,
  type PersistedWindowState,
  type Project,
  type Tag,
  type TaskViewState,
  type WindowGeometry,
  type WindowSessionState,
  type WindowViewState
} from '../shared/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export class Storage {
  private configPath: string
  private projectsPath: string
  private windowSessionPath: string

  constructor(dir: string) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this.configPath = path.join(dir, 'config.json')
    this.projectsPath = path.join(dir, 'projects.json')
    this.windowSessionPath = path.join(dir, 'window-session.json')
  }

  /** Rotating startup snapshot of projects.json — recovery net if another instance clobbers it. */
  backupProjectsOnStartup(keep = 10): void {
    try {
      if (!fs.existsSync(this.projectsPath)) return
      const backupsDir = path.join(path.dirname(this.projectsPath), 'backups')
      fs.mkdirSync(backupsDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(this.projectsPath, path.join(backupsDir, `projects-${stamp}.json`))
      const snapshots = fs
        .readdirSync(backupsDir)
        .filter(f => f.startsWith('projects-') && f.endsWith('.json'))
        .sort()
      for (const f of snapshots.slice(0, -keep)) {
        fs.unlinkSync(path.join(backupsDir, f))
      }
    } catch {
      // best-effort: never block startup on backup failure
    }
  }

  loadConfig(): AppConfig {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const { collapsedFolderIds: _legacy, ...rest } = parsed
      return { ...DEFAULT_CONFIG, ...rest } as AppConfig
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  saveConfig(config: AppConfig): void {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2))
  }

  loadProjects(): ProjectsData {
    try {
      const raw = fs.readFileSync(this.projectsPath, 'utf-8')
      const data = JSON.parse(raw)
      return Storage.normalizeProjectsData(data)
    } catch {
      return { projects: [], tags: [], projectOrder: [], pinnedItems: [] }
    }
  }

  static normalizeProjectsData(data: Record<string, unknown>): ProjectsData {
    const projects: Project[] = Array.isArray(data.projects) ? data.projects : []
    const projectIds = new Set(projects.map(p => p.id))
    const tagIds = new Set(
      (Array.isArray(data.tags) ? data.tags as Tag[] : [])
        .filter((t): t is Tag => typeof t?.id === 'string' && typeof t?.name === 'string')
        .map(t => t.id)
    )

    let tags: Tag[] = Array.isArray(data.tags)
      ? (data.tags as Tag[]).filter(
          (t): t is Tag => typeof t?.id === 'string' && typeof t?.name === 'string' && tagIds.has(t.id)
        )
      : []

    let projectOrder: string[] = Array.isArray(data.projectOrder)
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

    for (const project of normalizedProjects) {
      if (!Array.isArray(project.tasks)) continue
      for (const task of project.tasks) {
        const legacy = (task as { lastFocusedAt?: unknown }).lastFocusedAt
        if (typeof legacy === 'number' && task.lastInteractedAt === undefined) {
          task.lastInteractedAt = legacy
        }
        delete (task as { lastFocusedAt?: unknown }).lastFocusedAt
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
    fs.writeFileSync(this.projectsPath, JSON.stringify(normalized, null, 2))
  }

  loadWindowSession(projectsData: ProjectsData): WindowSessionState {
    try {
      const raw = fs.readFileSync(this.windowSessionPath, 'utf-8')
      const data = JSON.parse(raw)
      return Storage.normalizeWindowSessionData(data, projectsData)
    } catch {
      return createDefaultWindowSessionState()
    }
  }

  saveWindowSession(data: WindowSessionState): void {
    fs.writeFileSync(this.windowSessionPath, JSON.stringify(data, null, 2))
  }

  static normalizeWindowSessionData(data: unknown, projectsData: ProjectsData): WindowSessionState {
    if (!isRecord(data) || !Array.isArray(data.windows)) {
      return createDefaultWindowSessionState()
    }

    const tagIds = new Set(projectsData.tags.map(tag => tag.id))
    const windows = data.windows
      .map((entry) => Storage.normalizePersistedWindowState(entry, projectsData.projects, tagIds))
      .filter((entry): entry is PersistedWindowState => entry !== null)

    return { windows }
  }

  private static normalizePersistedWindowState(
    value: unknown,
    projects: Project[],
    tagIds: Set<string>
  ): PersistedWindowState | null {
    if (!isRecord(value)) return null

    const geometry = Storage.normalizeWindowGeometry(value.geometry)
    if (!geometry) return null

    const viewState = Storage.normalizeWindowViewState(value.viewState, projects, tagIds)
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
    tagIds: Set<string>
  ): WindowViewState {
    if (!isRecord(value)) {
      return createDefaultWindowViewState()
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
        sidebarWidth: isFiniteNumber(value.sidebarWidth) ? value.sidebarWidth : 240
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

import fs from 'fs'
import path from 'path'
import {
  AppConfig,
  DEFAULT_CONFIG,
  ProjectsData,
  createDefaultWindowSessionState,
  createDefaultWindowViewState,
  reconcileWindowViewState,
  type Folder,
  type PersistedWindowState,
  type Project,
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

  loadConfig(): AppConfig {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8')
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
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
      return { projects: [], folders: [], rootOrder: [] }
    }
  }

  static normalizeProjectsData(data: Record<string, unknown>): ProjectsData {
    const projects: Project[] = Array.isArray(data.projects) ? data.projects : []
    const projectIds = new Set(projects.map(p => p.id))
    let folders: Folder[] = Array.isArray(data.folders) ? data.folders : []
    let rootOrder: string[] = Array.isArray(data.rootOrder) ? data.rootOrder : projects.map(p => p.id)

    const placedProjects = new Set<string>()

    const folderIds = new Set(folders.map(f => f.id))
    folders = folders.map(f => ({
      ...f,
      projectIds: f.projectIds.filter(pid => {
        if (!projectIds.has(pid) || placedProjects.has(pid)) return false
        placedProjects.add(pid)
        return true
      })
    }))

    rootOrder = rootOrder.filter(id => {
      if (folderIds.has(id)) return true
      if (projectIds.has(id) && !placedProjects.has(id)) {
        placedProjects.add(id)
        return true
      }
      return false
    })

    for (const p of projects) {
      if (!placedProjects.has(p.id)) {
        rootOrder.push(p.id)
      }
    }

    return { projects, folders, rootOrder }
  }

  saveProjects(data: ProjectsData): void {
    fs.writeFileSync(this.projectsPath, JSON.stringify(data, null, 2))
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

    const folderIds = new Set(projectsData.folders.map(folder => folder.id))
    const windows = data.windows
      .map((entry) => Storage.normalizePersistedWindowState(entry, projectsData.projects, folderIds))
      .filter((entry): entry is PersistedWindowState => entry !== null)

    return { windows }
  }

  private static normalizePersistedWindowState(
    value: unknown,
    projects: Project[],
    folderIds: Set<string>
  ): PersistedWindowState | null {
    if (!isRecord(value)) return null

    const geometry = Storage.normalizeWindowGeometry(value.geometry)
    if (!geometry) return null

    const viewState = Storage.normalizeWindowViewState(value.viewState, projects, folderIds)
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
    folderIds: Set<string>
  ): WindowViewState {
    if (!isRecord(value)) {
      return createDefaultWindowViewState()
    }

    const taskStates = Storage.normalizeTaskStates(value.taskStates)
    const collapsedFolderIds = Array.isArray(value.collapsedFolderIds)
      ? value.collapsedFolderIds.filter((folderId): folderId is string => typeof folderId === 'string' && folderIds.has(folderId))
      : []

    return reconcileWindowViewState(
      {
        selectedProjectId: typeof value.selectedProjectId === 'string' ? value.selectedProjectId : null,
        selectedTaskId: typeof value.selectedTaskId === 'string' ? value.selectedTaskId : null,
        collapsedFolderIds,
        taskStates
      },
      projects,
      collapsedFolderIds
    )
  }

  private static normalizeTaskStates(value: unknown): Record<string, TaskViewState> {
    if (!isRecord(value)) return {}

    const taskStates: Record<string, TaskViewState> = {}
    for (const [taskId, taskState] of Object.entries(value)) {
      if (!isRecord(taskState)) continue
      const activeTab = isRecord(taskState.activeTab) ? taskState.activeTab : {}
      taskStates[taskId] = {
        activeTab: {
          left: typeof activeTab.left === 'string' ? activeTab.left : null,
          right: typeof activeTab.right === 'string' ? activeTab.right : null
        },
        splitOpen: typeof taskState.splitOpen === 'boolean' ? taskState.splitOpen : false,
        splitRatio: isFiniteNumber(taskState.splitRatio) ? taskState.splitRatio : 0.5
      }
    }

    return taskStates
  }
}

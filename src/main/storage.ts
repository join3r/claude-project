import fs from 'fs'
import path from 'path'
import { AppConfig, DEFAULT_CONFIG, ProjectsData, type Folder, type Project } from '../shared/types'

export class Storage {
  private configPath: string
  private projectsPath: string

  constructor(dir: string) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    this.configPath = path.join(dir, 'config.json')
    this.projectsPath = path.join(dir, 'projects.json')
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
}

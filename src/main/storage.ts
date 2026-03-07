import fs from 'fs'
import path from 'path'
import { AppConfig, DEFAULT_CONFIG, ProjectsData } from '../shared/types'

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
      return JSON.parse(raw)
    } catch {
      return { projects: [] }
    }
  }

  saveProjects(data: ProjectsData): void {
    fs.writeFileSync(this.projectsPath, JSON.stringify(data, null, 2))
  }
}

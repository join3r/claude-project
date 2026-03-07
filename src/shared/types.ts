export interface Tab {
  id: string
  type: 'terminal' | 'browser'
  title: string
  url?: string
}

export interface Task {
  id: string
  name: string
  tabs: {
    left: Tab[]
    right: Tab[]
  }
  activeTab: {
    left: string | null
    right: string | null
  }
  splitOpen: boolean
}

export interface Project {
  id: string
  name: string
  directory: string
  tasks: Task[]
}

export interface ProjectsData {
  projects: Project[]
}

export interface AppConfig {
  fontFamily: string
  fontSize: number
  theme: 'system' | 'dark' | 'light'
  defaultShell: string
}

export const DEFAULT_CONFIG: AppConfig = {
  fontFamily: 'monospace',
  fontSize: 14,
  theme: 'system',
  defaultShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh'
}

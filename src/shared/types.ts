export type TabType = 'terminal' | 'browser' | 'claude' | 'codex' | 'opencode'

export const AI_TAB_TYPES = ['claude', 'codex', 'opencode'] as const
export type AiTabType = typeof AI_TAB_TYPES[number]

export const AI_TAB_META: Record<AiTabType, { label: string; command: string }> = {
  claude: { label: 'Claude Code', command: 'claude' },
  codex: { label: 'Codex', command: 'codex' },
  opencode: { label: 'OpenCode', command: 'opencode' }
}

export interface Tab {
  id: string
  type: TabType
  title: string
  url?: string
  sessionId?: string
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
  splitRatio: number
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
  terminalTheme: 'system' | 'dark' | 'light'
  defaultShell: string
  enableClaude: boolean
  enableCodex: boolean
  enableOpencode: boolean
}

export const DEFAULT_CONFIG: AppConfig = {
  fontFamily: 'monospace',
  fontSize: 14,
  theme: 'system',
  terminalTheme: 'system',
  defaultShell: typeof process !== 'undefined' && process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh',
  enableClaude: false,
  enableCodex: false,
  enableOpencode: false
}

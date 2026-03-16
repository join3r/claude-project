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
  workspace?: WorkspaceConfig
}

export interface WorkspaceConfig {
  worktreePath: string
  branchName: string
  baseBranch: string
  relativeProjectPath: string
}

export function isWorkspaceTask(task: Task): boolean {
  return !!task.workspace
}

export interface Project {
  id: string
  name: string
  directory: string
  tasks: Task[]
  lastTaskId?: string
  ssh?: SshConfig
  shellCommand?: ShellCommandConfig
  aiToolArgs?: Partial<Record<AiTabType, string>>
}

export function isRemoteProject(project: Project): boolean {
  return !!project.ssh
}

export interface SshConfig {
  host: string
  port: number
  username: string
  keyFile?: string
  remoteDir: string
}

export interface ShellCommandConfig {
  command: string
}

export function isShellCommandProject(project: Project): boolean {
  return !!project.shellCommand
}

export interface Folder {
  id: string
  name: string
  projectIds: string[]
}

export interface ProjectsData {
  projects: Project[]
  folders: Folder[]
  rootOrder: string[]
}

export interface AppConfig {
  fontFamily: string
  fontSize: number
  theme: 'system' | 'dark' | 'light'
  terminalTheme: 'system' | 'dark' | 'light'
  defaultShell: string
  copyOnSelect: boolean
  enableClaude: boolean
  enableCodex: boolean
  enableOpencode: boolean
  lastProjectId: string | null
  lastTaskId: string | null
  collapsedFolderIds: string[]
}

export const DEFAULT_CONFIG: AppConfig = {
  fontFamily: 'monospace',
  fontSize: 14,
  theme: 'system',
  terminalTheme: 'system',
  defaultShell: typeof process !== 'undefined' && process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh',
  copyOnSelect: false,
  enableClaude: false,
  enableCodex: false,
  enableOpencode: false,
  lastProjectId: null,
  lastTaskId: null,
  collapsedFolderIds: []
}

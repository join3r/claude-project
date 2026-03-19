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

export interface TaskViewState {
  activeTab: {
    left: string | null
    right: string | null
  }
  splitOpen: boolean
  splitRatio: number
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

export interface WindowViewState {
  selectedProjectId: string | null
  selectedTaskId: string | null
  collapsedFolderIds: string[]
  taskStates: Record<string, TaskViewState>
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

export function createTaskViewState(task: Task): TaskViewState {
  return {
    activeTab: {
      left: task.activeTab.left ?? task.tabs.left[task.tabs.left.length - 1]?.id ?? null,
      right: task.activeTab.right ?? task.tabs.right[task.tabs.right.length - 1]?.id ?? null
    },
    splitOpen: task.splitOpen,
    splitRatio: task.splitRatio
  }
}

export function createDefaultWindowViewState(): WindowViewState {
  return {
    selectedProjectId: null,
    selectedTaskId: null,
    collapsedFolderIds: [],
    taskStates: {}
  }
}

export function cloneWindowViewState(state: WindowViewState): WindowViewState {
  return {
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    collapsedFolderIds: [...state.collapsedFolderIds],
    taskStates: Object.fromEntries(
      Object.entries(state.taskStates).map(([taskId, taskState]) => [
        taskId,
        {
          activeTab: {
            left: taskState.activeTab.left,
            right: taskState.activeTab.right
          },
          splitOpen: taskState.splitOpen,
          splitRatio: taskState.splitRatio
        }
      ])
    )
  }
}

export function resolveStoredSelection(projects: Project[], config: AppConfig): Pick<WindowViewState, 'selectedProjectId' | 'selectedTaskId'> {
  if (!config.lastProjectId) {
    return { selectedProjectId: null, selectedTaskId: null }
  }

  const project = projects.find((candidate) => candidate.id === config.lastProjectId)
  if (!project) {
    return { selectedProjectId: null, selectedTaskId: null }
  }

  const candidateTaskId = config.lastTaskId ?? project.lastTaskId ?? null
  const taskId = candidateTaskId && project.tasks.some((task) => task.id === candidateTaskId)
    ? candidateTaskId
    : null

  return {
    selectedProjectId: project.id,
    selectedTaskId: taskId
  }
}

export function reconcileTaskViewState(task: Task, state?: TaskViewState): TaskViewState {
  const fallback = createTaskViewState(task)
  if (!state) return fallback

  const leftIds = new Set(task.tabs.left.map(tab => tab.id))
  const rightIds = new Set(task.tabs.right.map(tab => tab.id))

  return {
    activeTab: {
      left: state.activeTab.left === null
        ? null
        : leftIds.has(state.activeTab.left)
          ? state.activeTab.left
          : fallback.activeTab.left,
      right: state.activeTab.right === null
        ? null
        : rightIds.has(state.activeTab.right)
          ? state.activeTab.right
          : fallback.activeTab.right
    },
    splitOpen: state.splitOpen,
    splitRatio: state.splitRatio
  }
}

export function reconcileWindowViewState(
  state: WindowViewState,
  projects: Project[],
  collapsedFolderIds?: string[]
): WindowViewState {
  const projectById = new Map(projects.map(project => [project.id, project]))
  const selectedProject = state.selectedProjectId ? projectById.get(state.selectedProjectId) ?? null : null
  const selectedTask = selectedProject && state.selectedTaskId
    ? selectedProject.tasks.find(task => task.id === state.selectedTaskId) ?? null
    : null

  const taskStates: Record<string, TaskViewState> = {}
  for (const project of projects) {
    for (const task of project.tasks) {
      const nextState = state.taskStates[task.id]
      if (nextState) {
        taskStates[task.id] = reconcileTaskViewState(task, nextState)
      }
    }
  }

  return {
    selectedProjectId: selectedProject?.id ?? null,
    selectedTaskId: selectedTask?.id ?? null,
    collapsedFolderIds: collapsedFolderIds ? [...collapsedFolderIds] : [...state.collapsedFolderIds],
    taskStates
  }
}

export function buildWindowViewState(
  projects: Project[],
  config: AppConfig,
  seed?: Partial<WindowViewState> | null
): WindowViewState {
  const storedSelection = resolveStoredSelection(projects, config)

  return reconcileWindowViewState({
    selectedProjectId: seed?.selectedProjectId ?? storedSelection.selectedProjectId,
    selectedTaskId: seed?.selectedTaskId ?? storedSelection.selectedTaskId,
    collapsedFolderIds: seed?.collapsedFolderIds ? [...seed.collapsedFolderIds] : [...config.collapsedFolderIds],
    taskStates: seed?.taskStates
      ? cloneWindowViewState({
          ...createDefaultWindowViewState(),
          ...seed,
          taskStates: seed.taskStates
        }).taskStates
      : {}
  }, projects)
}

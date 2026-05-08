export type TabType = 'terminal' | 'browser' | 'claude' | 'codex' | 'opencode' | 'diff' | 'editor' | 'note'

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
  filePath?: string
  noteId?: string
  pinned?: boolean
}

export interface ProjectNote {
  id: string
  name: string
  content: string
  createdAt: number
  updatedAt: number
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
  lastFocusedAt?: number
}

export interface WorkspaceConfig {
  worktreePath: string
  branchName: string
  baseBranch: string
  relativeProjectPath: string
}

export interface WorkspaceTarget {
  projectDir: string
  projectId?: string
  sshConfig?: SshConfig
}

export interface WorkspaceListBranchesRequest extends WorkspaceTarget {}

export interface WorkspaceCreateRequest extends WorkspaceTarget {
  name: string
  baseBranch: string
}

export interface WorkspaceDeleteRequest extends WorkspaceTarget {
  worktreePath: string
  branchName: string
  baseBranch: string
  force?: boolean
  keepBranch?: boolean
}

export function isWorkspaceTask(task: Task): boolean {
  return !!task.workspace
}

export interface Project {
  id: string
  name: string
  emoji?: string
  icon?: string
  directory: string
  tasks: Task[]
  lastTaskId?: string
  ssh?: SshConfig
  tunnel?: TunnelConfig
  shellCommand?: ShellCommandConfig
  aiToolArgs?: Partial<Record<AiTabType, string>>
  lifetimeStats?: { tasksCreated: number; notesCreated: number }
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

export interface TunnelConfig {
  host: string
  sourcePort: number
  destinationPort: number
}

export type TunnelStatus = 'inactive' | 'active' | 'error'

export interface TunnelState {
  status: TunnelStatus
  error?: string
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
  terminalColorScheme: TerminalColorScheme
  defaultShell: string
  copyOnSelect: boolean
  editorFontFamily: string
  editorFontSize: number
  editorWordWrap: EditorWordWrap
  editorLineNumbers: EditorLineNumbers
  editorRenderWhitespace: EditorRenderWhitespace
  editorMinimap: boolean
  editorTabSize: number
  diffRenderSideBySide: boolean
  diffIgnoreTrimWhitespace: boolean
  enableClaude: boolean
  enableCodex: boolean
  enableOpencode: boolean
  lazyLoadClaude: boolean
  lastProjectId: string | null
  lastTaskId: string | null
  collapsedFolderIds: string[]
  taskRecencyHighlight: {
    enabled: boolean
    mode: 'rank' | 'time'
    rankCount: number
    timeWindowMinutes: number
  }
  activityPanel: {
    enabled: boolean
    heightPx: number
  }
}

export type TerminalColorScheme =
  | 'auto'
  | 'solarized-dark'
  | 'solarized-light'
  | 'one-dark'
  | 'dracula'
  | 'monokai'
  | 'classic'

export type EditorWordWrap = 'off' | 'on' | 'bounded'

export type EditorLineNumbers = 'off' | 'on' | 'relative' | 'interval'

export type EditorRenderWhitespace = 'none' | 'boundary' | 'selection' | 'trailing' | 'all'

export type FileBrowserTab = 'files' | 'git' | 'notes'

export interface DirectoryEntry {
  name: string
  type: 'file' | 'directory'
  relativePath: string
}

export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'U' | '?'

export interface GitStatusEntry {
  relativePath: string
  status: GitFileStatus
}

export interface GitDiffSummary {
  added: number
  deleted: number
}

export interface GitStatusResult {
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
  untracked: GitStatusEntry[]
  summary: GitDiffSummary
}

export interface GitPostureLastCommit {
  sha: string
  subject: string
  author: string
  isoDate: string
}

export interface GitPostureResult {
  isGitRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  dirtyCount: number
  lastCommit: GitPostureLastCommit | null
}

export interface CommitHistoryResult {
  commits: string[]
}

export interface GitOperationResult {
  success: boolean
  message: string
}

export interface WindowViewState {
  selectedProjectId: string | null
  selectedTaskId: string | null
  collapsedFolderIds: string[]
  expandedProjectIds: string[]
  taskStates: Record<string, TaskViewState>
  fileBrowserOpen: boolean
  fileBrowserWidth: number
  fileBrowserActiveTab: FileBrowserTab
  watchStripHiddenProjectIds: string[]
}

export interface WindowGeometry {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

export interface PersistedWindowState {
  geometry: WindowGeometry
  viewState: WindowViewState
}

export interface WindowSessionState {
  windows: PersistedWindowState[]
}

export const DEFAULT_CONFIG: AppConfig = {
  fontFamily: 'monospace',
  fontSize: 14,
  theme: 'system',
  terminalTheme: 'system',
  terminalColorScheme: 'auto',
  defaultShell: '',
  copyOnSelect: false,
  editorFontFamily: 'monospace',
  editorFontSize: 14,
  editorWordWrap: 'off',
  editorLineNumbers: 'on',
  editorRenderWhitespace: 'selection',
  editorMinimap: false,
  editorTabSize: 4,
  diffRenderSideBySide: true,
  diffIgnoreTrimWhitespace: true,
  enableClaude: false,
  enableCodex: false,
  enableOpencode: false,
  lazyLoadClaude: true,
  lastProjectId: null,
  lastTaskId: null,
  collapsedFolderIds: [],
  taskRecencyHighlight: {
    enabled: true,
    mode: 'rank',
    rankCount: 5,
    timeWindowMinutes: 1440
  },
  activityPanel: {
    enabled: true,
    heightPx: 160
  }
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

function createDefaultTaskStates(projects: Project[]): Record<string, TaskViewState> {
  const taskStates: Record<string, TaskViewState> = {}
  for (const project of projects) {
    for (const task of project.tasks) {
      taskStates[task.id] = createTaskViewState(task)
    }
  }
  return taskStates
}

export function createDefaultWindowViewState(): WindowViewState {
  return {
    selectedProjectId: null,
    selectedTaskId: null,
    collapsedFolderIds: [],
    expandedProjectIds: [],
    taskStates: {},
    fileBrowserOpen: false,
    fileBrowserWidth: 250,
    fileBrowserActiveTab: 'files',
    watchStripHiddenProjectIds: []
  }
}

export function cloneWindowViewState(state: WindowViewState): WindowViewState {
  return {
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    collapsedFolderIds: [...state.collapsedFolderIds],
    expandedProjectIds: [...state.expandedProjectIds],
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
    ),
    fileBrowserOpen: state.fileBrowserOpen,
    fileBrowserWidth: state.fileBrowserWidth,
    fileBrowserActiveTab: state.fileBrowserActiveTab,
    watchStripHiddenProjectIds: [...state.watchStripHiddenProjectIds]
  }
}

export function cloneWindowGeometry(geometry: WindowGeometry): WindowGeometry {
  return {
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    isMaximized: geometry.isMaximized
  }
}

export function clonePersistedWindowState(state: PersistedWindowState): PersistedWindowState {
  return {
    geometry: cloneWindowGeometry(state.geometry),
    viewState: cloneWindowViewState(state.viewState)
  }
}

export function createDefaultWindowSessionState(): WindowSessionState {
  return { windows: [] }
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

  const expandedProjectIds = (state.expandedProjectIds ?? []).filter(id => projectById.has(id))

  return {
    selectedProjectId: selectedProject?.id ?? null,
    selectedTaskId: selectedTask?.id ?? null,
    collapsedFolderIds: collapsedFolderIds ? [...collapsedFolderIds] : [...state.collapsedFolderIds],
    expandedProjectIds,
    taskStates,
    fileBrowserOpen: state.fileBrowserOpen ?? false,
    fileBrowserWidth: state.fileBrowserWidth ?? 250,
    fileBrowserActiveTab: state.fileBrowserActiveTab ?? 'files',
    watchStripHiddenProjectIds: Array.isArray(state.watchStripHiddenProjectIds) ? [...state.watchStripHiddenProjectIds] : []
  }
}

export function buildWindowViewState(
  projects: Project[],
  config: AppConfig,
  seed?: Partial<WindowViewState> | null
): WindowViewState {
  const storedSelection = resolveStoredSelection(projects, config)
  const taskStates = createDefaultTaskStates(projects)
  if (seed?.taskStates) {
    for (const [taskId, taskState] of Object.entries(seed.taskStates)) {
      taskStates[taskId] = {
        activeTab: {
          left: taskState.activeTab.left,
          right: taskState.activeTab.right
        },
        splitOpen: taskState.splitOpen,
        splitRatio: taskState.splitRatio
      }
    }
  }

  const selectedProjectId = seed?.selectedProjectId ?? storedSelection.selectedProjectId
  const selectedTaskId = seed?.selectedTaskId ?? storedSelection.selectedTaskId

  const expandedProjectIds = seed?.expandedProjectIds
    ? [...seed.expandedProjectIds]
    : (selectedProjectId ? [selectedProjectId] : [])

  return reconcileWindowViewState({
    selectedProjectId,
    selectedTaskId,
    collapsedFolderIds: seed?.collapsedFolderIds ? [...seed.collapsedFolderIds] : [...config.collapsedFolderIds],
    expandedProjectIds,
    taskStates,
    watchStripHiddenProjectIds: []
  }, projects)
}

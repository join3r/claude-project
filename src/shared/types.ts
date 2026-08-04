export type TabType = 'terminal' | 'browser' | 'claude' | 'codex' | 'pi' | 'diff' | 'editor' | 'note' | 'home'

export const AI_TAB_TYPES = ['claude', 'codex', 'pi'] as const
export type AiTabType = typeof AI_TAB_TYPES[number]

export const AI_TAB_META: Record<AiTabType, { label: string; command: string }> = {
  claude: { label: 'Claude Code', command: 'claude' },
  codex: { label: 'Codex', command: 'codex' },
  pi: { label: 'Pi', command: 'pi' }
}

/** What the New-task composer opens in a task it just created. */
export const NEW_TASK_AUTO_OPEN = ['none', 'claude', 'codex', 'pi', 'browser', 'terminal'] as const
export type NewTaskAutoOpen = typeof NEW_TASK_AUTO_OPEN[number]

export interface Tab {
  id: string
  type: TabType
  title: string
  url?: string
  sessionId?: string
  filePath?: string
  noteId?: string
  system?: 'home'
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
  fileBrowserOpen?: boolean
  fileBrowserActiveTab?: FileBrowserTab
}

/**
 * Inbox triage state for a task. Every field is optional, so tasks written by older
 * builds need no migration — the whole object is simply absent.
 */
export interface TaskInboxState {
  /** Stamped when the task is switched to. Drives unread. */
  visitedAt?: number
  /** Any meaningful event: hook notification/stop, terminal bell, PTY exit. */
  eventAt?: number
  /** Question / permission / bell specifically — a subset of eventAt. */
  attentionAt?: number
  settledAt?: number
  snoozedAt?: number
  /** Epoch ms wake time. Absent when snoozeUntilAttention is set. */
  snoozedUntil?: number
  snoozeUntilAttention?: boolean
  /** Manual "mark unread"; cleared on the next visit. */
  forcedUnread?: boolean
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
  lastInteractedAt?: number
  inbox?: TaskInboxState
  system?: 'home'
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

export function isHomeTask(task: Task): boolean {
  return task.system === 'home'
}

export function isHomeTab(tab: Tab): boolean {
  return tab.system === 'home'
}

const RENAMABLE_TAB_TYPES: readonly TabType[] = ['terminal', 'browser', 'claude', 'codex', 'pi']

export function isRenamableTab(tab: Tab): boolean {
  if (isHomeTab(tab)) return false
  return RENAMABLE_TAB_TYPES.includes(tab.type)
}

export function createHomeTask(projectId: string): { task: Task; tab: Tab } {
  const tabId = `home-tab-${projectId}`
  const tab: Tab = {
    id: tabId,
    type: 'home',
    title: 'Home',
    system: 'home'
  }
  const task: Task = {
    id: `home-task-${projectId}`,
    name: 'Home',
    tabs: { left: [tab], right: [] },
    activeTab: { left: tabId, right: null },
    splitOpen: false,
    splitRatio: 0.5,
    system: 'home'
  }
  return { task, tab }
}

export function ensureHomeTasks(projects: Project[]): { projects: Project[]; changed: boolean } {
  let changed = false
  const next = projects.map((project) => {
    if (project.tasks.some((t) => t.system === 'home')) return project
    changed = true
    const { task } = createHomeTask(project.id)
    return { ...project, tasks: [task, ...project.tasks] }
  })
  return { projects: changed ? next : projects, changed }
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
  tagIds?: string[]
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

export interface Tag {
  id: string
  name: string
}

export interface ProjectsData {
  projects: Project[]
  tags: Tag[]
  projectOrder: string[]
  pinnedItems: PinnedItem[]
}

export type PinnedItem =
  | { type: 'project'; projectId: string }
  | { type: 'task'; projectId: string; taskId: string }

export function pinnedItemKey(item: PinnedItem): string {
  return item.type === 'project' ? `project:${item.projectId}` : `task:${item.projectId}:${item.taskId}`
}

export function normalizePinnedItems(items: unknown, projects: readonly Project[]): PinnedItem[] {
  if (!Array.isArray(items)) return []
  const projectById = new Map(projects.map(p => [p.id, p]))
  const seen = new Set<string>()
  const result: PinnedItem[] = []
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Partial<PinnedItem> & { projectId?: unknown; taskId?: unknown }
    if (typeof item.projectId !== 'string') continue
    const project = projectById.get(item.projectId)
    if (!project) continue
    let normalized: PinnedItem
    if (item.type === 'project') {
      normalized = { type: 'project', projectId: item.projectId }
    } else if (item.type === 'task' && typeof item.taskId === 'string') {
      const tasks = Array.isArray(project.tasks) ? project.tasks : []
      if (!tasks.some(t => t.id === item.taskId)) continue
      normalized = { type: 'task', projectId: item.projectId, taskId: item.taskId }
    } else {
      continue
    }
    const key = pinnedItemKey(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

/** OR filter: empty selection shows all; otherwise project must have at least one selected tag. */
export function projectMatchesTagFilter(project: Project, selectedTagIds: readonly string[]): boolean {
  if (selectedTagIds.length === 0) return true
  const projectTags = project.tagIds ?? []
  return selectedTagIds.some(tagId => projectTags.includes(tagId))
}

export function filterProjectsByTags<T extends Project>(
  projects: readonly T[],
  selectedTagIds: readonly string[]
): T[] {
  return projects.filter(p => projectMatchesTagFilter(p, selectedTagIds))
}

export function pruneUnusedTags(data: ProjectsData): ProjectsData {
  const usedTagIds = new Set<string>()
  for (const project of data.projects) {
    for (const tagId of project.tagIds ?? []) {
      usedTagIds.add(tagId)
    }
  }
  const tags = (data.tags ?? []).filter(tag => usedTagIds.has(tag.id))
  const tagIds = new Set(tags.map(t => t.id))
  const projects = data.projects.map(project => ({
    ...project,
    tagIds: (project.tagIds ?? []).filter(id => tagIds.has(id))
  }))
  return { ...data, tags, projects }
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
  enablePi: boolean
  lazyLoadClaude: boolean
  lastProjectId: string | null
  lastTaskId: string | null
  defaultSidebarTab: SidebarTab
  newTaskAutoOpen: NewTaskAutoOpen
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
  selectedTagIds: string[]
  expandedProjectIds: string[]
  taskStates: Record<string, TaskViewState>
  fileBrowserOpen: boolean
  fileBrowserWidth: number
  fileBrowserActiveTab: FileBrowserTab
  sidebarWidth: number
  sidebarProjectsCollapsed: boolean
  sidebarTab: SidebarTab
}

export type SidebarTab = 'projects' | 'inbox'

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
  enablePi: false,
  lazyLoadClaude: true,
  lastProjectId: null,
  lastTaskId: null,
  defaultSidebarTab: 'inbox',
  // Opt-in: creating a task keeps behaving exactly as before until you pick a tool.
  newTaskAutoOpen: 'none',
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
    selectedTagIds: [],
    expandedProjectIds: [],
    taskStates: {},
    fileBrowserOpen: false,
    fileBrowserWidth: 250,
    fileBrowserActiveTab: 'files',
    sidebarWidth: 240,
    sidebarProjectsCollapsed: false,
    sidebarTab: 'projects'
  }
}

export function cloneWindowViewState(state: WindowViewState): WindowViewState {
  return {
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    selectedTagIds: [...state.selectedTagIds],
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
          splitRatio: taskState.splitRatio,
          ...(taskState.fileBrowserOpen !== undefined ? { fileBrowserOpen: taskState.fileBrowserOpen } : {}),
          ...(taskState.fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab: taskState.fileBrowserActiveTab } : {})
        }
      ])
    ),
    fileBrowserOpen: state.fileBrowserOpen,
    fileBrowserWidth: state.fileBrowserWidth,
    fileBrowserActiveTab: state.fileBrowserActiveTab,
    sidebarWidth: state.sidebarWidth,
    sidebarProjectsCollapsed: state.sidebarProjectsCollapsed,
    sidebarTab: state.sidebarTab
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
  const remembered = candidateTaskId && project.tasks.some((task) => task.id === candidateTaskId)
    ? candidateTaskId
    : null

  const homeTask = project.tasks.find((task) => task.system === 'home') ?? null
  const taskId = remembered ?? homeTask?.id ?? null

  return {
    selectedProjectId: project.id,
    selectedTaskId: taskId
  }
}

export function reconcileTaskViewState(task: Task, state?: TaskViewState): TaskViewState {
  // For home tasks, ensure the home tab exists in the left pane and is active by default.
  if (task.system === 'home') {
    const hasHomeTab = task.tabs.left.some((tab) => tab.system === 'home')
    if (!hasHomeTab) {
      const projectId = task.id.startsWith('home-task-')
        ? task.id.slice('home-task-'.length)
        : task.id
      const { tab } = createHomeTask(projectId)
      task.tabs.left.unshift(tab)
      if (!task.activeTab.left) task.activeTab.left = tab.id
    }
  }

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
    splitRatio: state.splitRatio,
    ...(state.fileBrowserOpen !== undefined ? { fileBrowserOpen: state.fileBrowserOpen } : {}),
    ...(state.fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab: state.fileBrowserActiveTab } : {})
  }
}

export function reconcileWindowViewState(
  state: WindowViewState,
  projects: Project[],
  tagIds?: Set<string>
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

  const validTagIds = tagIds ?? new Set<string>()
  const selectedTagIds = (state.selectedTagIds ?? []).filter(id => validTagIds.has(id))

  return {
    selectedProjectId: selectedProject?.id ?? null,
    selectedTaskId: selectedTask?.id ?? null,
    selectedTagIds,
    expandedProjectIds,
    taskStates,
    fileBrowserOpen: state.fileBrowserOpen ?? false,
    fileBrowserWidth: state.fileBrowserWidth ?? 250,
    fileBrowserActiveTab: state.fileBrowserActiveTab ?? 'files',
    sidebarWidth: state.sidebarWidth ?? 240,
    sidebarProjectsCollapsed: state.sidebarProjectsCollapsed ?? false,
    // only normalise unrecognised values — buildWindowViewState already applied the configured default
    sidebarTab: state.sidebarTab === 'inbox' || state.sidebarTab === 'projects' ? state.sidebarTab : 'projects'
  }
}

export function buildWindowViewState(
  projects: Project[],
  config: AppConfig,
  seed?: Partial<WindowViewState> | null,
  tags: readonly Tag[] = []
): WindowViewState {
  const tagIds = new Set(tags.map(t => t.id))
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
        splitRatio: taskState.splitRatio,
        ...(taskState.fileBrowserOpen !== undefined ? { fileBrowserOpen: taskState.fileBrowserOpen } : {}),
        ...(taskState.fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab: taskState.fileBrowserActiveTab } : {})
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
    selectedTagIds: seed?.selectedTagIds ? [...seed.selectedTagIds] : [],
    expandedProjectIds,
    taskStates,
    fileBrowserOpen: seed?.fileBrowserOpen ?? false,
    fileBrowserWidth: seed?.fileBrowserWidth ?? 250,
    fileBrowserActiveTab: seed?.fileBrowserActiveTab ?? 'files',
    sidebarWidth: seed?.sidebarWidth ?? 240,
    sidebarProjectsCollapsed: seed?.sidebarProjectsCollapsed ?? false,
    sidebarTab: seed?.sidebarTab ?? config.defaultSidebarTab
  }, projects, tagIds)
}

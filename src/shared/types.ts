import { DEFAULT_MOBILE_CONFIG, type MobileConfig } from './mobile'

export type TabType = 'terminal' | 'browser' | 'claude' | 'claude-chat' | 'codex' | 'pi' | 'diff' | 'editor' | 'notebook' | 'note'

export const AI_TAB_TYPES = ['claude', 'codex', 'pi'] as const
export type AiTabType = typeof AI_TAB_TYPES[number]

export const AI_TAB_META: Record<AiTabType, { label: string; command: string }> = {
  claude: { label: 'Claude Code', command: 'claude' },
  codex: { label: 'Codex', command: 'codex' },
  pi: { label: 'Pi', command: 'pi' }
}

/**
 * Tabs that run a coding agent: the terminal AI tabs plus the Claude chat tab,
 * which drives the same `claude` through the Agent SDK instead of a PTY. Status,
 * the inbox and the sidebar's activity line treat them all alike.
 */
export function isAgentTabType(type: TabType): boolean {
  return type === 'claude-chat' || (AI_TAB_TYPES as readonly string[]).includes(type)
}

export const CLAUDE_CHAT_LABEL = 'Claude'

/** Which way a new Claude tab opens: the terminal UI, or DevTool's chat. */
export type ClaudeView = 'terminal' | 'chat'

/** What a task is called until its first prompt names it. */
export const NEW_TASK_NAME = 'New Task'

/** The agents an empty task's prompt box can start: Claude as a chat or a terminal, Codex, Pi. */
export const PROMPT_BOX_AGENTS = ['claude-chat', 'claude', 'codex', 'pi'] as const
export type PromptBoxAgent = typeof PROMPT_BOX_AGENTS[number]

/**
 * The live state of one tab's process. Lives in shared rather than in the
 * renderer's TabStatusContext because main keeps the authoritative copy too
 * (see `src/main/tab-activity-registry.ts`) and idle cleanup reads both.
 */
export type TabStatusValue = 'working' | 'attention' | 'exited' | null

export interface Tab {
  id: string
  type: TabType
  title: string
  url?: string
  sessionId?: string
  filePath?: string
  noteId?: string
  /** Terminal spawn directory; when omitted, the task/project directory is used. */
  cwd?: string
}

export interface ProjectNote {
  id: string
  name: string
  content: string
  createdAt: number
  updatedAt: number
}

/**
 * What one window remembers per task beyond the task itself: the file-browser
 * sidebar. The pane layout (columns, widths, active tabs) lives on the task.
 */
export interface TaskViewState {
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

/**
 * One column of a task's pane row. Never empty: a pane exists only while it holds a tab.
 * `width` is the pane's share of the row (the shares of a task's panes add up to 1).
 */
export interface TaskPane {
  tabs: Tab[]
  activeTabId: string
  width: number
}

/**
 * One agent session (or one terminal) and the tabs that came with it. Lives in a
 * stream; the stream owns the worktree.
 */
export interface Task {
  id: string
  name: string
  /**
   * The agent (or terminal) tab the task is about. Absent while the task has no tab
   * yet (a new task on its prompt box) or holds neither an agent nor a terminal.
   */
  mainTabId?: string
  /** One row of columns, left to right. Empty only while the task has no tab. */
  panes: TaskPane[]
  /**
   * TEMPORARY (removed in step 6): a task whose stream has no worktree yet. The
   * worktree is created (branch named after the first prompt) when the first tab
   * opens, and lands on the task's stream.
   */
  workspaceDraft?: WorkspaceDraft
  lastInteractedAt?: number
  inbox?: TaskInboxState
}

/**
 * A line of work: a release (`0.5.0`) or anything else (`bugfixes`). Owns the
 * worktree, or works in the project folder when `workspace` is absent.
 */
export interface Stream {
  id: string
  /** Free text, e.g. "0.5.0". */
  name: string
  /** The project's default project-folder stream; every project has exactly one. */
  isMain?: true
  workspace?: WorkspaceConfig
  tasks: Task[]
  lastTaskId?: string
}

export interface WorkspaceDraft {
  /** The branch the worktree will fork from; unset means main, then master, then the first branch. */
  baseBranch?: string
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

/**
 * Outcome of a workspace deletion attempt. The safety checks fail *closed*:
 * - `check-failed`  a safety check could not be completed (missing base branch, git error,
 *                   timeout, unreachable host). Nothing was deleted; `force` can override.
 * - `invalid-worktree`  the recorded path is not a registered worktree of the repository, so
 *                   the recursive-delete fallback was refused. `force` does *not* override this.
 */
export type WorkspaceDeleteStatus =
  | 'ok'
  | 'uncommitted'
  | 'unmerged'
  | 'uncommitted-and-unmerged'
  | 'check-failed'
  | 'invalid-worktree'

export interface WorkspaceDeleteResult {
  status: WorkspaceDeleteStatus
  baseBranch?: string
  /** Human-readable explanation for `check-failed` / `invalid-worktree`. */
  reason?: string
}

const RENAMABLE_TAB_TYPES: readonly TabType[] = ['terminal', 'browser', 'claude', 'claude-chat', 'codex', 'pi']

export function isRenamableTab(tab: Tab): boolean {
  return RENAMABLE_TAB_TYPES.includes(tab.type)
}

/** The `main` stream's id for a project. */
export function mainStreamId(projectId: string): string {
  return `main-${projectId}`
}

export const MAIN_STREAM_NAME = 'main'

export function createMainStream(projectId: string, tasks: Task[] = []): Stream {
  return { id: mainStreamId(projectId), name: MAIN_STREAM_NAME, isMain: true, tasks }
}

export interface Project {
  id: string
  name: string
  emoji?: string
  icon?: string
  directory: string
  /** Lines of work. The first is always the `main` stream (`isMain`). */
  streams: Stream[]
  lastStreamId?: string
  ssh?: SshConfig
  tunnel?: TunnelConfig
  shellCommand?: ShellCommandConfig
  aiToolArgs?: Partial<Record<AiTabType, string>>
  /**
   * Conda / micromamba env name (display + fallback lookup).
   * Spawn prefers `condaEnvPrefix` when that folder is still a real env.
   */
  condaEnvName?: string
  /** Absolute conda env prefix. Unique when two installs share a name. */
  condaEnvPrefix?: string
  lifetimeStats?: { tasksCreated: number; notesCreated: number }
  tagIds?: string[]
  /**
   * A project the user never asked for: created behind the composer's "Use a
   * directory…" so a task can have a working directory without cluttering the
   * tree. Hidden from every project list, and swept away once its last real task
   * is gone. Clearing the flag promotes it to an ordinary project.
   */
  ephemeral?: true
  /** Left out of the inbox sent to paired phones — filtered before encryption. */
  hideFromMobile?: true
}

export function isRemoteProject(project: Project): boolean {
  return !!project.ssh
}

export function isEphemeralProject(project: Project): boolean {
  return !!project.ephemeral
}

/** A hidden ad-hoc project is spent once it has no task left. */
export function isSpentEphemeralProject(project: Project): boolean {
  return isEphemeralProject(project)
    && !(project.streams ?? []).some(stream => stream.tasks.length > 0)
}

export interface SshConfig {
  host: string
  port: number
  username: string
  keyFile?: string
  /** Remote start directory. Empty means “the user’s home”; filled in on connect. */
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

/**
 * Every window holds a full snapshot of the shared state, so a plain "here is my
 * copy" save lets whichever IPC lands last erase the other window's change. The
 * canonical copy in main therefore carries a revision, and a save has to name the
 * revision it was derived from — a compare-and-swap. A save whose base is stale is
 * refused and handed the canonical state back so the renderer can rebase onto it.
 */
export interface RevisionEnvelope<T> {
  revision: number
  data: T
}

export type RevisionSaveResult<T> =
  | { ok: true; revision: number }
  | { ok: false; revision: number; data: T }

export type NotesRecord = Record<string, ProjectNote[]>
export type ProjectsEnvelope = RevisionEnvelope<ProjectsData>
export type ProjectsSaveResult = RevisionSaveResult<ProjectsData>
export type NotesEnvelope = RevisionEnvelope<NotesRecord>
export type NotesSaveResult = RevisionSaveResult<NotesRecord>

export type PinnedItem =
  | { type: 'project'; projectId: string }
  | { type: 'stream'; projectId: string; streamId: string }
  | { type: 'task'; projectId: string; streamId: string; taskId: string }

export function pinnedItemKey(item: PinnedItem): string {
  switch (item.type) {
    case 'project': return `project:${item.projectId}`
    case 'stream': return `stream:${item.projectId}:${item.streamId}`
    case 'task': return `task:${item.projectId}:${item.taskId}`
  }
}

/**
 * Drop pins whose target is gone, and duplicates. A task pin follows its task:
 * `streamId` is rewritten to the stream that holds the task now.
 */
export function normalizePinnedItems(items: unknown, projects: readonly Project[]): PinnedItem[] {
  if (!Array.isArray(items)) return []
  const projectById = new Map(projects.map(p => [p.id, p]))
  const seen = new Set<string>()
  const result: PinnedItem[] = []
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as { type?: unknown; projectId?: unknown; streamId?: unknown; taskId?: unknown }
    if (typeof item.projectId !== 'string') continue
    const project = projectById.get(item.projectId)
    if (!project) continue
    const streams = Array.isArray(project.streams) ? project.streams : []
    let normalized: PinnedItem
    if (item.type === 'project') {
      normalized = { type: 'project', projectId: item.projectId }
    } else if (item.type === 'stream' && typeof item.streamId === 'string') {
      if (!streams.some(s => s.id === item.streamId)) continue
      normalized = { type: 'stream', projectId: item.projectId, streamId: item.streamId }
    } else if (item.type === 'task' && typeof item.taskId === 'string') {
      const taskId = item.taskId
      const stream = streams.find(s => s.tasks.some(t => t.id === taskId))
      if (!stream) continue
      normalized = { type: 'task', projectId: item.projectId, streamId: stream.id, taskId }
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
  /**
   * Unix: login-shell path. Empty uses `$SHELL`.
   * Windows + Git Bash: optional `bash.exe` path. Empty auto-detects Git for Windows.
   */
  defaultShell: string
  /**
   * Kept so old config.json still loads. Always coerced to Git Bash.
   * PowerShell and Command Prompt are not product surfaces on this fork.
   */
  windowsTerminal: WindowsTerminal
  /**
   * Folder of a portable Node zip (contains `node.exe` / `node`).
   * Prepended to PATH for new local terminal and Pi tabs. Empty means do not prepend.
   */
  portableNodeDir: string
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
  /** App-wide list of external IDEs. Empty until the user adds or Detects them. */
  externalEditors: ExternalEditorsConfig
  enableClaude: boolean
  enableCodex: boolean
  enablePi: boolean
  /** Absolute path or command name. Empty uses the default (`claude` / `codex` / `pi`). */
  claudeCommand: string
  codexCommand: string
  piCommand: string
  lazyLoadClaude: boolean
  /** Hold off system sleep while any agent tab is working (the display may still sleep). */
  keepAwakeWhileWorking: boolean
  /** Settings → Updates: look for a newer release at launch and every few hours (packaged builds). */
  autoCheckUpdates: boolean
  /** New Claude tabs (task auto-open, the tab bar's ✦) open as a terminal or a chat. */
  claudeDefaultView: ClaudeView
  lastProjectId: string | null
  lastTaskId: string | null
  defaultSidebarTab: SidebarTab
  /** Inbox: sink tasks whose agent is working to the bottom of their group. */
  inboxWorkingLast: boolean
  /** The agent an empty task's prompt box preselects: the last one a prompt was sent to. */
  promptBoxAgent: PromptBoxAgent
  /** The permission mode the prompt box last started Claude with; '' leaves Claude's own default. */
  promptBoxMode: string
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
  idleTaskCleanup: IdleTaskCleanupConfig
  /**
   * Settings → Mobile. Owned by main's `mobile-*` IPC: `save-config` ignores it so a
   * window's stale copy cannot flip it back.
   */
  mobile?: MobileConfig
}

/** One configured editor used to open the local project folder. */
export interface ExternalEditor {
  id: string
  name: string
  /** Absolute path preferred; a command name on PATH is also accepted. */
  command: string
  /** Extra CLI flags, split on whitespace. The folder is always appended last. */
  extraArgs: string
}

export interface ExternalEditorsConfig {
  editors: ExternalEditor[]
  defaultId: string | null
}

/**
 * Auto-deletion of tasks that have gone quiet. Ships off: the sweep deletes silently, so
 * nothing happens until it is deliberately enabled.
 */
/**
 * Everything idle cleanup exempts a task for, as main sees it across every window:
 * what is selected somewhere, what the hooks have reported, what still has a live
 * process, and what holds an unsaved buffer.
 */
export interface CleanupActivity {
  openTaskIds: string[]
  statuses: Record<string, TabStatusValue>
  liveTabIds: string[]
  dirtyTabIds: string[]
}

/** A task main deleted on its own (idle cleanup), and the tabs that went with it. */
export interface TaskRemoval {
  projectId: string
  taskId: string
  tabIds: string[]
}

export interface IdleTaskCleanupConfig {
  enabled: boolean
  /** Idle longer than `days`. */
  byAge: { enabled: boolean; days: number }
  /** More than `maxTasks` tasks in the project. */
  byCount: { enabled: boolean; maxTasks: number }
  /** How the two rules compose. Irrelevant unless both are enabled. */
  combine: 'and' | 'or'
  /** Only touch tasks explicitly settled in the inbox. */
  settledOnly: boolean
  /** Also delete workspace tasks whose worktree is clean and branch already merged. */
  includeCleanWorkspaces: boolean
}

/** Interactive Windows tabs are Git Bash only. Legacy `powershell` / `cmd` values coerce here. */
export type WindowsTerminal = 'git-bash'

export function coerceWindowsTerminal(_value: unknown): WindowsTerminal {
  return 'git-bash'
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
  /** For rename/copy entries: the path the file came from. */
  origPath?: string
}

/**
 * Every path a git operation must touch for a status entry. Rename/copy
 * entries need the original path too — unstaging only the new path would leave
 * the old one deleted in the index.
 */
export function gitEntryPaths(entry: GitStatusEntry): string[] {
  return entry.origPath ? [entry.relativePath, entry.origPath] : [entry.relativePath]
}

export interface GitDiffSummary {
  added: number
  deleted: number
}

/** One repository inside a project: the root (`path: ''`) or a nested checkout. */
export interface GitRepoStatus {
  /** Project-relative, `/`-separated; `''` for the project root. */
  path: string
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
  untracked: GitStatusEntry[]
  /** Set when the panel declined to run git in this repo, and why. */
  skipped?: string
}

/**
 * Every entry path is project-relative, nested repos included. The flat lists
 * merge all repos (file tree colouring, the toolbar summary); `repos` keeps
 * them apart for the git panel.
 */
export interface GitStatusResult {
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
  untracked: GitStatusEntry[]
  summary: GitDiffSummary
  repos: GitRepoStatus[]
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
  windowsTerminal: 'git-bash',
  portableNodeDir: '',
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
  claudeCommand: '',
  codexCommand: '',
  piCommand: '',
  lazyLoadClaude: true,
  keepAwakeWhileWorking: true,
  autoCheckUpdates: true,
  claudeDefaultView: 'terminal',
  lastProjectId: null,
  lastTaskId: null,
  defaultSidebarTab: 'inbox',
  inboxWorkingLast: false,
  promptBoxAgent: 'claude-chat',
  promptBoxMode: '',
  taskRecencyHighlight: {
    enabled: true,
    mode: 'rank',
    rankCount: 5,
    timeWindowMinutes: 1440
  },
  activityPanel: {
    enabled: true,
    heightPx: 160
  },
  // Opt-in: the sweep deletes without asking, so it stays dormant until you turn it on.
  idleTaskCleanup: {
    enabled: false,
    byAge: { enabled: true, days: 14 },
    byCount: { enabled: true, maxTasks: 20 },
    combine: 'and',
    settledOnly: true,
    includeCleanWorkspaces: false
  },
  externalEditors: { editors: [], defaultId: null },
  mobile: { ...DEFAULT_MOBILE_CONFIG }
}

/** A task's default view: nothing remembered yet, so the window's own sidebar shows. */
export function createTaskViewState(_task?: Task): TaskViewState {
  return {}
}

/** A detached copy holding only the known fields (stored states may carry legacy ones). */
export function cloneTaskViewState(state: TaskViewState): TaskViewState {
  return {
    ...(state.fileBrowserOpen !== undefined ? { fileBrowserOpen: state.fileBrowserOpen } : {}),
    ...(state.fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab: state.fileBrowserActiveTab } : {})
  }
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
        cloneTaskViewState(taskState)
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

  // No remembered task means the window was on the project's Home page; a stale
  // one falls back to the task the project was last left on.
  const tasks = project.streams.flatMap(stream => stream.tasks)
  const streamLastTaskId = project.streams.find(stream => stream.id === project.lastStreamId)?.lastTaskId
  const exists = (id: string | null | undefined): id is string => !!id && tasks.some((task) => task.id === id)
  const taskId = config.lastTaskId === null
    ? null
    : exists(config.lastTaskId)
      ? config.lastTaskId
      : exists(streamLastTaskId) ? streamLastTaskId : null

  return {
    selectedProjectId: project.id,
    selectedTaskId: taskId
  }
}

export function reconcileTaskViewState(_task: Task, state?: TaskViewState): TaskViewState {
  return state ? cloneTaskViewState(state) : createTaskViewState()
}

export function reconcileWindowViewState(
  state: WindowViewState,
  projects: Project[],
  tagIds?: Set<string>
): WindowViewState {
  const projectById = new Map(projects.map(project => [project.id, project]))
  const selectedProject = state.selectedProjectId ? projectById.get(state.selectedProjectId) ?? null : null
  const selectedTask = selectedProject && state.selectedTaskId
    ? selectedProject.streams.flatMap(stream => stream.tasks).find(task => task.id === state.selectedTaskId) ?? null
    : null

  const taskStates: Record<string, TaskViewState> = {}
  for (const project of projects) {
    for (const task of project.streams.flatMap(stream => stream.tasks)) {
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
  const taskStates: Record<string, TaskViewState> = {}
  if (seed?.taskStates) {
    for (const [taskId, taskState] of Object.entries(seed.taskStates)) {
      taskStates[taskId] = cloneTaskViewState(taskState)
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

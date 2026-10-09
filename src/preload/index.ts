import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  CommitHistoryResult,
  DirectoryEntry,
  GitOperationResult,
  GitPostureResult,
  GitStatusResult,
  NotesEnvelope,
  NotesRecord,
  NotesSaveResult,
  ProjectsData,
  SshConfig,
  TabStatusValue,
  TaskRemoval,
  TunnelConfig,
  TunnelState,
  WorkspaceCreateRequest,
  WorkspaceCreateResult,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResult,
  WorkspaceListBranchesRequest,
  WorkspaceRestoreRequest,
  WorkspaceRestoreResult,
  WindowViewState,
  EnsureTaskWorktreeOptions,
  PendingWorktreeSetup,
  StreamSetupResult,
  TaskLanding,
  TaskLandingPreview,
  TaskLandingResult,
  TaskWorktreeResult,
  TaskWorktreeState,
  WorktreeSetupDecision
} from '../shared/types'
import type { ArchivedStream, ArchivedTask, ProjectArchive } from '../shared/archive'
import type { CondaListResult } from '../shared/conda'
import type { NotebookKernelCondaOverride, NotebookKernelEvent } from '../shared/notebook'
import type { AgentActivity } from '../shared/agent-activity'
import type { MobilePairingInvite, MobileState } from '../shared/mobile'
import type { UpdateStatus } from '../shared/updates'
import type { ServerDeviceCode, ServerInvite, ServerRemoveOptions, ServerStatus, ServersState, ServerUpdateResult, SshInstallExit, SshInstallTarget } from '../shared/servers'
import type { ProjectsSources, ProjectsUpdate, SourceSaveResult } from '../shared/projects-sources'
import type { HostCloneResult, HostDirListing, HostRepoDiscovery } from '../shared/host-fs'
import type { AiStatusEvent } from '../shared/ai-status'
import type { ChatEvent, ChatImage, ChatLoginMethod, ChatPromptResponse, ChatSideAnswer, ChatSnapshot } from '../shared/claude-chat'
import type { PermissionBehavior, PermissionSettingsSource, PermissionSourceKind } from '../shared/chat-permissions'

const api = {
  // Projects
  // Projects and notes are revision-guarded: a save quotes the revision it was
  // derived from and main refuses it if another window got there first. Projects
  // come from several sources (this desktop, each DevTool server), each with its
  // own revision (shared/projects-sources.ts).
  loadProjects: (): Promise<ProjectsSources> => ipcRenderer.invoke('load-projects'),
  saveProjects: (source: string, payload: { baseRevision: number; data: ProjectsData }): Promise<SourceSaveResult> =>
    ipcRenderer.invoke('save-projects', source, payload),
  onProjectsUpdated: (callback: (update: ProjectsUpdate) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: ProjectsUpdate) => callback(update)
    ipcRenderer.on('projects-updated', handler)
    return () => ipcRenderer.removeListener('projects-updated', handler)
  },

  // A phone's task close runs entirely in main — a window only reports what main
  // cannot see (its unsaved buffers) and reacts to what main removed.
  reportDirtyTabs: (tabIds: string[]): Promise<void> => ipcRenderer.invoke('report-dirty-tabs', tabIds),
  /** Status of a tab main has no hooks for (Codex, shells), for the phone's inbox. */
  reportTabStatus: (tabId: string, status: TabStatusValue): Promise<void> => ipcRenderer.invoke('report-tab-status', tabId, status),
  /** This window moved a task to another directory: end these tabs' processes everywhere. */
  restartTabs: (tabIds: string[]): Promise<void> => ipcRenderer.invoke('tabs-restart', tabIds),
  /** Another window moved a task: drop these tabs, which mount again in the new directory. */
  onTabsRestart: (callback: (event: { tabIds: string[] }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { tabIds: string[] }) => callback(payload)
    ipcRenderer.on('tabs-restart', handler)
    return () => ipcRenderer.removeListener('tabs-restart', handler)
  },
  onTasksRemoved: (callback: (removal: TaskRemoval) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, removal: TaskRemoval) => callback(removal)
    ipcRenderer.on('tasks-removed', handler)
    return () => ipcRenderer.removeListener('tasks-removed', handler)
  },
  /** Main closed some of a task's tabs by itself (the phone's `tab.close`); the task stays. */
  onTabsRemoved: (callback: (removal: TaskRemoval) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, removal: TaskRemoval) => callback(removal)
    ipcRenderer.on('tabs-removed', handler)
    return () => ipcRenderer.removeListener('tabs-removed', handler)
  },
  /** Resolves false when no snapshot was written — nothing destructive may follow. */
  backupProjectsNow: (): Promise<boolean> => ipcRenderer.invoke('backup-projects-now'),

  // Config
  loadConfig: (): Promise<AppConfig> => ipcRenderer.invoke('load-config'),
  saveConfig: (config: AppConfig): Promise<void> => ipcRenderer.invoke('save-config', config),
  onConfigUpdated: (callback: (config: AppConfig) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, config: AppConfig) => callback(config)
    ipcRenderer.on('config-updated', handler)
    return () => ipcRenderer.removeListener('config-updated', handler)
  },

  // Notes
  notesLoad: (): Promise<NotesEnvelope> => ipcRenderer.invoke('notes-load'),
  notesSave: (payload: { baseRevision: number; data: NotesRecord }): Promise<NotesSaveResult> =>
    ipcRenderer.invoke('notes-save', payload),
  onNotesUpdated: (callback: (envelope: NotesEnvelope) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, envelope: NotesEnvelope) => callback(envelope)
    ipcRenderer.on('notes-updated', handler)
    return () => ipcRenderer.removeListener('notes-updated', handler)
  },

  // Palette frecency
  paletteFrecencyLoad: (): Promise<{ version: 1; entries: Record<string, { lastUsedAt: number; useCount: number }> }> =>
    ipcRenderer.invoke('palette-frecency:load'),
  paletteFrecencySave: (file: { version: 1; entries: Record<string, { lastUsedAt: number; useCount: number }> }): Promise<void> =>
    ipcRenderer.invoke('palette-frecency:save', file),
  openDevTools: (): Promise<void> => ipcRenderer.invoke('app:open-devtools'),
  quitApp: (): Promise<void> => ipcRenderer.invoke('app:quit'),

  // Window state
  loadWindowState: (): Promise<WindowViewState> => ipcRenderer.invoke('load-window-state'),
  saveWindowState: (viewState: WindowViewState): Promise<void> => ipcRenderer.invoke('save-window-state', viewState),
  openWindow: (viewState?: WindowViewState): Promise<void> => ipcRenderer.invoke('open-window', viewState),

  // Directory picker
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('pick-directory'),

  // File picker
  pickFile: (title?: string): Promise<string | null> =>
    ipcRenderer.invoke('pick-file', title),

  condaListEnvs: (projectId?: string): Promise<CondaListResult> =>
    ipcRenderer.invoke('conda-list-envs', projectId),

  externalIdeDetect: (): Promise<Array<{ name: string; command: string }>> =>
    ipcRenderer.invoke('external-ide-detect'),
  openInIde: (editorId: string, folder: string, projectId?: string): Promise<void> =>
    ipcRenderer.invoke('open-in-ide', editorId, folder, projectId),

  /** Main-process platform. Renderer uses this for Windows-only Settings. */
  platform: process.platform,

  // SSH
  sshConnect: (projectId: string, sshConfig: SshConfig): Promise<void> =>
    ipcRenderer.invoke('ssh-connect', projectId, sshConfig),
  sshDisconnect: (projectId: string, sshConfig: SshConfig): Promise<void> =>
    ipcRenderer.invoke('ssh-disconnect', projectId, sshConfig),
  sshStatus: (projectId: string): Promise<'connected' | 'connecting' | 'disconnected'> =>
    ipcRenderer.invoke('ssh-status', projectId),
  onSshStatusChanged: (callback: (projectId: string, status: string) => void): void => {
    ipcRenderer.on('ssh-status-changed', (_e, projectId, status) => callback(projectId, status))
  },
  sshSetTunnel: (projectId: string, sshConfig: SshConfig, tunnel: TunnelConfig | null): Promise<void> =>
    ipcRenderer.invoke('ssh-set-tunnel', projectId, sshConfig, tunnel),
  sshTunnelStatus: (projectId: string): Promise<TunnelState> =>
    ipcRenderer.invoke('ssh-tunnel-status', projectId),
  onSshTunnelStatusChanged: (callback: (projectId: string, state: TunnelState) => void): void => {
    ipcRenderer.on('ssh-tunnel-status-changed', (_e, projectId, status, error) => callback(projectId, error ? { status, error } : { status }))
  },

  // SOCKS proxy
  socksProxyEnable: (projectId: string, sshConfig: SshConfig): Promise<{ port: number }> =>
    ipcRenderer.invoke('socks-proxy-enable', projectId, sshConfig),
  socksProxyDisable: (projectId: string): Promise<void> =>
    ipcRenderer.invoke('socks-proxy-disable', projectId),
  socksProxyStatus: (projectId: string): Promise<{ enabled: boolean | undefined; port?: number }> =>
    ipcRenderer.invoke('socks-proxy-status', projectId),
  onSocksProxyStatusChanged: (callback: (projectId: string, enabled: boolean, port?: number) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, projectId: string, enabled: boolean, port?: number) => callback(projectId, enabled, port)
    ipcRenderer.on('socks-proxy-status-changed', handler)
    return () => ipcRenderer.removeListener('socks-proxy-status-changed', handler)
  },

  // Theme
  getNativeTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('get-native-theme'),
  clipboardWriteText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard-write-text', text),
  /** Open a project/workspace directory in the OS file manager, or select a path under it. */
  revealInFolder: (folder: string, relativePath?: string, projectId?: string): Promise<void> =>
    ipcRenderer.invoke('reveal-in-folder', folder, relativePath, projectId),
  clipboardReadText: (): Promise<string> => ipcRenderer.invoke('clipboard-read-text'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
  onThemeChanged: (callback: (theme: 'dark' | 'light') => void): void => {
    ipcRenderer.on('theme-changed', (_e, theme) => callback(theme))
  },

  // Scrollback
  scrollbackSave: (tabId: string, data: string): Promise<void> => ipcRenderer.invoke('scrollback-save', tabId, data),
  scrollbackSaveSync: (tabId: string, data: string): void => { ipcRenderer.sendSync('scrollback-save-sync', tabId, data) },
  scrollbackLoad: (tabId: string): Promise<string | null> => ipcRenderer.invoke('scrollback-load', tabId),
  scrollbackDelete: (tabId: string): Promise<void> => ipcRenderer.invoke('scrollback-delete', tabId),

  // Hook injection
  // tabId identifies which tab owns the injection — hooks are shared per directory
  // and only come off disk once every owning tab has released them.
  hooksInject: (projectDir: string, tabId: string, projectId?: string): Promise<void> =>
    ipcRenderer.invoke('hooks-inject', projectDir, tabId, projectId),
  hooksCleanup: (projectDir: string, tabId: string, projectId?: string): Promise<void> =>
    ipcRenderer.invoke('hooks-cleanup', projectDir, tabId, projectId),
  hooksCleanupRemote: (projectId: string, sshConfig: SshConfig, remoteDir: string | undefined, tabId: string): Promise<void> =>
    ipcRenderer.invoke('hooks-cleanup-remote', projectId, sshConfig, remoteDir, tabId),

  // Codex session reading
  codexReadSession: (cwd: string, afterTs?: number, projectId?: string, sshConfig?: SshConfig): Promise<{ sessionId: string | null }> =>
    ipcRenderer.invoke('codex-read-session', cwd, afterTs, projectId, sshConfig),

  // Claude session existence check (before spawning with --resume)
  /**
   * Before a task moves from `fromDir` to `toDir`: copy its Claude/Pi sessions into
   * the new directory's session folder, and say which of `dirs` exist there.
   */
  taskMovePrepare: (
    fromDir: string,
    toDir: string,
    sessions: Array<{ kind: 'claude' | 'pi'; sessionId: string }>,
    dirs: string[],
    projectId?: string,
    sshConfig?: SshConfig
  ): Promise<{ dirsExist: boolean[] }> =>
    ipcRenderer.invoke('task-move-prepare', fromDir, toDir, sessions, dirs, projectId, sshConfig),
  claudeSessionExists: (cwd: string, sessionId: string, projectId?: string, sshConfig?: SshConfig): Promise<boolean> =>
    ipcRenderer.invoke('claude-session-exists', cwd, sessionId, projectId, sshConfig),

  // Hook events from server
  onHookSessionStart: (callback: (tabId: string, body: Record<string, unknown>) => void): void => {
    ipcRenderer.on('hook-session-start', (_e, tabId, body) => callback(tabId, body))
  },
  onHookWorking: (callback: (tabId: string) => void): void => {
    ipcRenderer.on('hook-working', (_e, tabId) => callback(tabId))
  },
  onHookStopped: (callback: (tabId: string, backgroundTasks: number) => void): void => {
    ipcRenderer.on('hook-stopped', (_e, tabId, backgroundTasks) => callback(tabId, typeof backgroundTasks === 'number' ? backgroundTasks : 0))
  },
  onHookNotification: (callback: (tabId: string, body: Record<string, unknown>) => void): void => {
    ipcRenderer.on('hook-notification', (_e, tabId, body) => callback(tabId, body))
  },
  /** Any other Claude hook; `statusEvent` is the status transition it implies, if any. */
  onHookActivity: (callback: (tabId: string, statusEvent: AiStatusEvent | null) => void): void => {
    ipcRenderer.on('hook-activity', (_e, tabId, statusEvent) => callback(tabId, statusEvent))
  },
  /** What each Claude tab is doing, across every window. `null` = forgotten. */
  getAgentActivity: (): Promise<Record<string, AgentActivity>> => ipcRenderer.invoke('get-agent-activity'),
  onAgentActivity: (callback: (tabId: string, activity: AgentActivity | null) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tabId: string, activity: AgentActivity | null) => callback(tabId, activity)
    ipcRenderer.on('agent-activity', handler)
    return () => ipcRenderer.removeListener('agent-activity', handler)
  },

  // Claude chat tabs (Agent SDK). Main owns the process; windows attach to it.
  chatAttach: (
    tabId: string,
    config: { cwd: string; sessionId: string; projectId?: string; sshConfig?: SshConfig; extraArgs?: string[] }
  ): Promise<ChatSnapshot> => ipcRenderer.invoke('chat-attach', tabId, config),
  chatDetach: (tabId: string): void => ipcRenderer.send('chat-detach', tabId),
  chatSend: (tabId: string, text: string, images?: ChatImage[]): Promise<void> =>
    ipcRenderer.invoke('chat-send', tabId, text, images),
  chatBash: (tabId: string, command: string): Promise<void> => ipcRenderer.invoke('chat-bash', tabId, command),
  chatLogin: (tabId: string, method: ChatLoginMethod): Promise<void> => ipcRenderer.invoke('chat-login', tabId, method),
  chatLoginCode: (tabId: string, code: string): Promise<void> => ipcRenderer.invoke('chat-login-code', tabId, code),
  chatLoginDismiss: (tabId: string): Promise<void> => ipcRenderer.invoke('chat-login-dismiss', tabId),
  chatLogout: (tabId: string): Promise<void> => ipcRenderer.invoke('chat-logout', tabId),
  chatSideQuestion: (tabId: string, question: string): Promise<ChatSideAnswer> =>
    ipcRenderer.invoke('chat-side-question', tabId, question),
  chatInterrupt: (tabId: string): Promise<void> => ipcRenderer.invoke('chat-interrupt', tabId),
  chatStopTask: (tabId: string, taskId: string): Promise<boolean> => ipcRenderer.invoke('chat-stop-task', tabId, taskId),
  chatBackgroundTask: (tabId: string, toolUseId: string): Promise<boolean> =>
    ipcRenderer.invoke('chat-background-task', tabId, toolUseId),
  chatRespond: (tabId: string, promptId: string, response: ChatPromptResponse): Promise<boolean> =>
    ipcRenderer.invoke('chat-respond', tabId, promptId, response),
  chatSetModel: (tabId: string, model?: string): Promise<void> => ipcRenderer.invoke('chat-set-model', tabId, model),
  chatSetMode: (tabId: string, mode: string): Promise<void> => ipcRenderer.invoke('chat-set-mode', tabId, mode),
  chatSetEffort: (tabId: string, effort?: string): Promise<void> => ipcRenderer.invoke('chat-set-effort', tabId, effort),
  chatStop: (tabId: string): Promise<void> => ipcRenderer.invoke('chat-stop', tabId),
  chatClose: (tabId: string): void => ipcRenderer.send('chat-close', tabId),
  chatListFiles: (cwd: string, projectId?: string, sshConfig?: SshConfig): Promise<string[]> =>
    ipcRenderer.invoke('chat-list-files', cwd, projectId, sshConfig),
  chatPermissionsRead: (cwd: string, projectId?: string): Promise<PermissionSettingsSource[]> =>
    ipcRenderer.invoke('chat-permissions-read', cwd, projectId),
  chatPermissionsUpdate: (
    cwd: string,
    kind: PermissionSourceKind,
    behavior: PermissionBehavior,
    rule: string,
    action: 'add' | 'remove',
    projectId?: string
  ): Promise<void> => ipcRenderer.invoke('chat-permissions-update', cwd, kind, behavior, rule, action, projectId),
  onChatEvent: (callback: (tabId: string, seq: number, event: ChatEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tabId: string, seq: number, event: ChatEvent) => callback(tabId, seq, event)
    ipcRenderer.on('chat-event', handler)
    return () => ipcRenderer.removeListener('chat-event', handler)
  },

  // PTY
  ptySpawn: (
    id: string,
    shell: string,
    cwd: string,
    cols: number,
    rows: number,
    args?: string[],
    extraEnv?: Record<string, string>,
    projectId?: string,
    sshConfig?: SshConfig
  ): Promise<{ cols: number; rows: number; scrollback: string; exitCode: number | null }> =>
    ipcRenderer.invoke('pty-spawn', id, shell, cwd, cols, rows, args, extraEnv, projectId, sshConfig),
  ptyWrite: (id: string, data: string): void => ipcRenderer.send('pty-write', id, data),
  ptyResize: (id: string, cols: number, rows: number): void => ipcRenderer.send('pty-resize', id, cols, rows),
  ptyKill: (id: string): void => ipcRenderer.send('pty-kill', id),
  onPtyData: (callback: (id: string, data: string) => void): void => {
    ipcRenderer.on('pty-data', (_e, id, data) => callback(id, data))
  },
  onPtySizeSync: (callback: (id: string, cols: number, rows: number) => void): void => {
    ipcRenderer.on('pty-size-sync', (_e, id, cols, rows) => callback(id, cols, rows))
  },
  onPtyExit: (callback: (id: string, exitCode: number) => void): void => {
    ipcRenderer.on('pty-exit', (_e, id, exitCode) => callback(id, exitCode))
  },

  // Menu shortcuts
  onMenuToggleSidebar: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-toggle-sidebar', handler)
    return () => ipcRenderer.removeListener('menu-toggle-sidebar', handler)
  },
  onMenuCloseTab: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-close-tab', handler)
    return () => ipcRenderer.removeListener('menu-close-tab', handler)
  },
  onMenuReopenClosedTab: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-reopen-closed-tab', handler)
    return () => ipcRenderer.removeListener('menu-reopen-closed-tab', handler)
  },
  onMenuReloadTab: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-reload-tab', handler)
    return () => ipcRenderer.removeListener('menu-reload-tab', handler)
  },
  onMenuNewStream: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-new-stream', handler)
    return () => ipcRenderer.removeListener('menu-new-stream', handler)
  },
  onMenuNewTask: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-new-task', handler)
    return () => ipcRenderer.removeListener('menu-new-task', handler)
  },
  onMenuNewTerminal: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-new-terminal', handler)
    return () => ipcRenderer.removeListener('menu-new-terminal', handler)
  },
  onMenuNewWindow: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-new-window', handler)
    return () => ipcRenderer.removeListener('menu-new-window', handler)
  },
  onMenuProjectSwitcher: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-project-switcher', handler)
    return () => ipcRenderer.removeListener('menu-project-switcher', handler)
  },
  onMenuZoomIn: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-zoom-in', handler)
    return () => ipcRenderer.removeListener('menu-zoom-in', handler)
  },
  onMenuZoomOut: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-zoom-out', handler)
    return () => ipcRenderer.removeListener('menu-zoom-out', handler)
  },
  onMenuZoomReset: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-zoom-reset', handler)
    return () => ipcRenderer.removeListener('menu-zoom-reset', handler)
  },
  onMenuOpenSettings: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-open-settings', handler)
    return () => ipcRenderer.removeListener('menu-open-settings', handler)
  },

  // File browser
  fbReadDirectory: (projectCwd: string, relativeDirPath: string, projectId?: string): Promise<DirectoryEntry[]> =>
    ipcRenderer.invoke('fb-read-directory', projectCwd, relativeDirPath, projectId),
  fbReadFile: (projectCwd: string, relativeFilePath: string, projectId?: string): Promise<string> =>
    ipcRenderer.invoke('fb-read-file', projectCwd, relativeFilePath, projectId),
  fbWriteFile: (projectCwd: string, relativeFilePath: string, content: string, projectId?: string): Promise<void> =>
    ipcRenderer.invoke('fb-write-file', projectCwd, relativeFilePath, content, projectId),
  fbCreateFile: (projectCwd: string, parentRelativePath: string, name: string, projectId?: string): Promise<DirectoryEntry> =>
    ipcRenderer.invoke('fb-create-file', projectCwd, parentRelativePath, name, projectId),
  fbCreateDirectory: (projectCwd: string, parentRelativePath: string, name: string, projectId?: string): Promise<DirectoryEntry> =>
    ipcRenderer.invoke('fb-create-directory', projectCwd, parentRelativePath, name, projectId),
  fbRename: (projectCwd: string, fromRelativePath: string, newName: string, projectId?: string): Promise<DirectoryEntry> =>
    ipcRenderer.invoke('fb-rename', projectCwd, fromRelativePath, newName, projectId),
  fbDelete: (projectCwd: string, relativePath: string, projectId?: string): Promise<void> =>
    ipcRenderer.invoke('fb-delete', projectCwd, relativePath, projectId),
  fbGitStatus: (projectCwd: string, projectId?: string): Promise<GitStatusResult> =>
    ipcRenderer.invoke('fb-git-status', projectCwd, projectId),
  gitProjectPosture: (projectCwd: string, projectId?: string): Promise<GitPostureResult> =>
    ipcRenderer.invoke('git-project-posture', projectCwd, projectId),
  gitCommitHistory: (projectCwd: string, projectId?: string): Promise<CommitHistoryResult> =>
    ipcRenderer.invoke('git-commit-history', projectCwd, projectId),
  fbGitDiff: (projectCwd: string, relativeFilePath: string, projectId?: string): Promise<string> =>
    ipcRenderer.invoke('fb-git-diff', projectCwd, relativeFilePath, projectId),
  // `repo` is a GitRepoStatus.path (project-relative, '' for the root);
  // `files` are project-relative paths inside it.
  fbGitStage: (projectCwd: string, repo: string, files: string[], projectId?: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-stage', projectCwd, repo, files, projectId),
  fbGitUnstage: (projectCwd: string, repo: string, files: string[], projectId?: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-unstage', projectCwd, repo, files, projectId),
  fbGitDiscard: (projectCwd: string, repo: string, files: string[], projectId?: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-discard', projectCwd, repo, files, projectId),
  fbGitPull: (projectCwd: string, repo: string, projectId?: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-pull', projectCwd, repo, projectId),
  fbGitCommit: (projectCwd: string, repo: string, message: string, projectId?: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-commit', projectCwd, repo, message, projectId),
  fbGitPush: (projectCwd: string, repo: string, projectId?: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-push', projectCwd, repo, projectId),

  // Menu: file browser toggle
  onMenuToggleFileBrowser: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-toggle-file-browser', handler)
    return () => ipcRenderer.removeListener('menu-toggle-file-browser', handler)
  },

  // Workspaces
  workspaceListBranches: (request: WorkspaceListBranchesRequest): Promise<string[]> =>
    ipcRenderer.invoke('workspace-list-branches', request),
  /** `setupError`: the worktree exists, but the repo's `.devtool/worktree.json` setup failed. */
  workspaceCreate: (request: WorkspaceCreateRequest): Promise<WorkspaceCreateResult> =>
    ipcRenderer.invoke('workspace-create', request),
  workspaceDelete: (request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteResult> =>
    ipcRenderer.invoke('workspace-delete', request),
  /** An archived stream's worktree back from its branch (`branch-missing` when it was discarded). */
  workspaceRestore: (request: WorkspaceRestoreRequest): Promise<WorkspaceRestoreResult> =>
    ipcRenderer.invoke('workspace-restore', request),

  // Task worktrees: made in main just before a task's tabs first spawn.
  taskWorktreeEnsure: (projectId: string, taskId: string, options?: EnsureTaskWorktreeOptions): Promise<TaskWorktreeResult> =>
    ipcRenderer.invoke('task-worktree-ensure', projectId, taskId, options),
  /** Answer a task's setup approval: run the commands (approving this config) or skip them. */
  taskWorktreeDecide: (taskId: string, decision: WorktreeSetupDecision): Promise<TaskWorktreeResult> =>
    ipcRenderer.invoke('task-worktree-decide', taskId, decision),
  taskWorktreeDismiss: (taskId: string): Promise<void> => ipcRenderer.invoke('task-worktree-dismiss', taskId),
  taskWorktreeStates: (): Promise<Record<string, TaskWorktreeState>> => ipcRenderer.invoke('task-worktree-states'),
  onTaskWorktreeState: (callback: (taskId: string, state: TaskWorktreeState | null) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string, state: TaskWorktreeState | null) => callback(taskId, state)
    ipcRenderer.on('task-worktree-state', handler)
    return () => ipcRenderer.removeListener('task-worktree-state', handler)
  },
  /** A new stream worktree's held setup commands: approve this config and run them. */
  streamWorktreeSetupRun: (projectId: string, streamId: string, pending: PendingWorktreeSetup): Promise<StreamSetupResult> =>
    ipcRenderer.invoke('stream-worktree-setup-run', projectId, streamId, pending),

  // Landing a task's worktree into its stream (main's TaskLandingManager). A stop is also on `Task.landing`.
  /** Close (default): land, stop the task's tabs, remove the worktree and branch, and archive the task (main does). `keepWorktree`: the Land action. */
  taskLand: (projectId: string, taskId: string, options?: { keepWorktree?: boolean }): Promise<TaskLandingResult> =>
    ipcRenderer.invoke('task-land', projectId, taskId, options),
  taskLandingRetry: (projectId: string, taskId: string): Promise<TaskLandingResult> =>
    ipcRenderer.invoke('task-landing-retry', projectId, taskId),
  taskLandingAbort: (projectId: string, taskId: string): Promise<TaskLandingResult> =>
    ipcRenderer.invoke('task-landing-abort', projectId, taskId),
  /** Ask the task's agent to resolve the conflict; the landing resumes once it goes idle with the rebase done. */
  taskLandingFix: (projectId: string, taskId: string): Promise<TaskLandingResult> =>
    ipcRenderer.invoke('task-landing-fix', projectId, taskId),
  taskUpdateFromStream: (projectId: string, taskId: string): Promise<TaskLandingResult> =>
    ipcRenderer.invoke('task-update-from-stream', projectId, taskId),
  /** Commits on the stream the task's branch doesn't have yet ("<stream> +N"); null when unknown. */
  taskStreamAhead: (projectId: string, taskId: string): Promise<number | null> =>
    ipcRenderer.invoke('task-stream-ahead', projectId, taskId),
  /** What closing would land (commits the stream lacks, uncommitted paths); null when unknown. */
  taskLandingPreview: (projectId: string, taskId: string): Promise<TaskLandingPreview | null> =>
    ipcRenderer.invoke('task-landing-preview', projectId, taskId),
  /**
   * Close without landing (main archives the task): `keep` the branch (and
   * `Task.workspace`, for reopen) or `discard` both. `archive: false` (its
   * stream closes next) leaves the task open, `Task.workspace` kept as a record.
   */
  taskWorktreeClose: (projectId: string, taskId: string, mode: 'keep' | 'discard', options?: { archive?: boolean }): Promise<TaskLandingResult> =>
    ipcRenderer.invoke('task-worktree-close', projectId, taskId, mode, options),
  onTaskLandingState: (callback: (taskId: string, landing: TaskLanding | null) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string, landing: TaskLanding | null) => callback(taskId, landing)
    ipcRenderer.on('task-landing-state', handler)
    return () => ipcRenderer.removeListener('task-landing-state', handler)
  },

  // Archive: `<config dir>/archive/<projectId>.json`. Each change resolves to the archive as it now is.
  archiveLoad: (projectId: string): Promise<ProjectArchive> => ipcRenderer.invoke('archive-load', projectId),
  archiveAddTasks: (projectId: string, entries: ArchivedTask[]): Promise<ProjectArchive> =>
    ipcRenderer.invoke('archive-add-tasks', projectId, entries),
  archiveAddStream: (projectId: string, entry: ArchivedStream): Promise<ProjectArchive> =>
    ipcRenderer.invoke('archive-add-stream', projectId, entry),
  archiveRemove: (projectId: string, ids: { tasks?: string[]; streams?: string[] }): Promise<ProjectArchive> =>
    ipcRenderer.invoke('archive-remove', projectId, ids),
  /** Scrollback of archived tabs deleted for good. */
  archiveDeleteTabs: (tabIds: string[]): Promise<void> => ipcRenderer.invoke('archive-delete-tabs', tabIds),
  /** A Claude session's messages (the SDK's), for an archived task's read-only view. */
  archiveTranscript: (sessionId: string, cwd: string, projectId?: string, sshConfig?: SshConfig): Promise<unknown[]> =>
    ipcRenderer.invoke('archive-transcript', sessionId, cwd, projectId, sshConfig),
  onArchiveChanged: (callback: (projectId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, projectId: string) => callback(projectId)
    ipcRenderer.on('archive-changed', handler)
    return () => ipcRenderer.removeListener('archive-changed', handler)
  },

  // Native notebooks. One jupyter_client helper per tab, local conda env only.
  notebookKernelStart: (
    tabId: string,
    projectId: string,
    cwd: string,
    condaOverride?: NotebookKernelCondaOverride | null
  ): Promise<{ error?: string; code?: string }> =>
    ipcRenderer.invoke('notebook-kernel-start', tabId, projectId, cwd, condaOverride),
  notebookKernelExecute: (
    tabId: string,
    requestId: string,
    code: string,
    cellId?: string
  ): Promise<{ error?: string }> =>
    ipcRenderer.invoke('notebook-kernel-execute', tabId, requestId, code, cellId),
  notebookKernelInterrupt: (tabId: string): Promise<void> =>
    ipcRenderer.invoke('notebook-kernel-interrupt', tabId),
  notebookKernelRestart: (
    tabId: string,
    projectId: string,
    cwd: string,
    condaOverride?: NotebookKernelCondaOverride | null
  ): Promise<{ error?: string; code?: string }> =>
    ipcRenderer.invoke('notebook-kernel-restart', tabId, projectId, cwd, condaOverride),
  notebookKernelShutdown: (tabId: string): Promise<void> =>
    ipcRenderer.invoke('notebook-kernel-shutdown', tabId),
  onNotebookKernelEvent: (callback: (tabId: string, event: NotebookKernelEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, event: NotebookKernelEvent) => callback(tabId, event)
    ipcRenderer.on('notebook-kernel-event', handler)
    return () => ipcRenderer.removeListener('notebook-kernel-event', handler)
  },
  // Mobile (Settings → Mobile). Main owns the state; every change is also broadcast.
  mobileGetState: (): Promise<MobileState> => ipcRenderer.invoke('mobile-get-state'),
  mobileSetEnabled: (enabled: boolean): Promise<MobileState> => ipcRenderer.invoke('mobile-set-enabled', enabled),
  mobileSetRelayUrl: (url: string): Promise<MobileState> => ipcRenderer.invoke('mobile-set-relay-url', url),
  mobileStartPairing: (): Promise<MobilePairingInvite> => ipcRenderer.invoke('mobile-start-pairing'),
  mobileCancelPairing: (): Promise<MobileState> => ipcRenderer.invoke('mobile-cancel-pairing'),
  mobileAccept: (phoneId: string): Promise<MobileState> => ipcRenderer.invoke('mobile-accept', phoneId),
  mobileReject: (phoneId: string): Promise<MobileState> => ipcRenderer.invoke('mobile-reject', phoneId),
  mobileRevoke: (phoneId: string): Promise<MobileState> => ipcRenderer.invoke('mobile-revoke', phoneId),
  onMobileStateChanged: (callback: (state: MobileState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: MobileState) => callback(state)
    ipcRenderer.on('mobile-state-changed', handler)
    return () => ipcRenderer.removeListener('mobile-state-changed', handler)
  },
  // Adding a project to a host (`host`: 'local' or a server id): its folders, its git repos, a clone.
  serverListDirs: (host: string, dir: string, options?: { showHidden?: boolean }): Promise<HostDirListing> =>
    ipcRenderer.invoke('server-list-dirs', host, dir, options),
  serverDiscoverRepos: (host: string, options?: { root?: string; maxDepth?: number }): Promise<HostRepoDiscovery> =>
    ipcRenderer.invoke('server-discover-repos', host, options),
  serverCloneRepo: (host: string, request: { url: string; parentDir?: string; name?: string; opId: string }): Promise<HostCloneResult> =>
    ipcRenderer.invoke('server-clone-repo', host, request),
  onServerCloneProgress: (callback: (opId: string, line: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, opId: string, line: string) => callback(opId, line)
    ipcRenderer.on('server-clone-progress', handler)
    return () => ipcRenderer.removeListener('server-clone-progress', handler)
  },
  // DevTool servers. Main owns the state; every change is also broadcast.
  serversGetState: (): Promise<ServersState> => ipcRenderer.invoke('servers-get-state'),
  /** A fresh install one-liner (15 minutes, single use); replaces the phone QR and any earlier invite. */
  serversCreateInvite: (): Promise<ServerInvite> => ipcRenderer.invoke('servers-create-invite'),
  serversCancelInvite: (): Promise<ServersState> => ipcRenderer.invoke('servers-cancel-invite'),
  /** "I have a code": a code from `devtool-server pair` on the server. Rejects with a readable message. */
  serversPairCode: (code: string): Promise<ServerStatus> => ipcRenderer.invoke('servers-pair-code', code),
  serversRename: (serverId: string, name: string): Promise<ServerStatus> => ipcRenderer.invoke('servers-rename', serverId, name),
  serversRemove: (serverId: string, options?: ServerRemoveOptions): Promise<{ uninstalled: boolean }> => ipcRenderer.invoke('servers-remove', serverId, options),
  /** Restart now, switching to a staged update ("Server update ready · Restart now"). */
  serversRestart: (serverId: string): Promise<void> => ipcRenderer.invoke('servers-restart', serverId),
  /** "Add another device": a pairing code the server mints for another desktop. */
  serversDeviceCode: (serverId: string): Promise<ServerDeviceCode> => ipcRenderer.invoke('servers-device-code', serverId),
  /** "Update": send this desktop's server bundle if it is newer than the server's. */
  serversUpdate: (serverId: string): Promise<ServerUpdateResult> => ipcRenderer.invoke('servers-update', serverId),
  onServersStateChanged: (callback: (state: ServersState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ServersState) => callback(state)
    ipcRenderer.on('servers-state-changed', handler)
    return () => ipcRenderer.removeListener('servers-state-changed', handler)
  },
  /** Add server › Install over SSH: runs the installer through the system ssh in a pty here. Main supplies the token. */
  serversSshInstallStart: (target: SshInstallTarget, size: { cols: number; rows: number }): Promise<{ sessionId: string; target: string }> =>
    ipcRenderer.invoke('servers-ssh-install-start', target, size),
  serversSshInstallInput: (sessionId: string, data: string): void => ipcRenderer.send('servers-ssh-install-input', sessionId, data),
  serversSshInstallResize: (sessionId: string, cols: number, rows: number): void => ipcRenderer.send('servers-ssh-install-resize', sessionId, cols, rows),
  serversSshInstallStop: (sessionId: string): Promise<void> => ipcRenderer.invoke('servers-ssh-install-stop', sessionId),
  onServersSshInstallData: (callback: (sessionId: string, data: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) => callback(sessionId, data)
    ipcRenderer.on('servers-ssh-install-data', handler)
    return () => ipcRenderer.removeListener('servers-ssh-install-data', handler)
  },
  onServersSshInstallExit: (callback: (sessionId: string, exit: SshInstallExit) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, exit: SshInstallExit) => callback(sessionId, exit)
    ipcRenderer.on('servers-ssh-install-exit', handler)
    return () => ipcRenderer.removeListener('servers-ssh-install-exit', handler)
  },
  // Updates (Settings → Updates). Main owns the state; every change is also broadcast.
  updatesGetStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates-get-status'),
  updatesCheck: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates-check'),
  updatesInstall: (): Promise<void> => ipcRenderer.invoke('updates-install'),
  onUpdatesStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status)
    ipcRenderer.on('updates-status', handler)
    return () => ipcRenderer.removeListener('updates-status', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api

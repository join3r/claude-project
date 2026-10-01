import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  CleanupActivity,
  CommitHistoryResult,
  DirectoryEntry,
  GitOperationResult,
  GitPostureResult,
  GitStatusResult,
  NotesEnvelope,
  NotesRecord,
  NotesSaveResult,
  ProjectsData,
  ProjectsEnvelope,
  ProjectsSaveResult,
  SshConfig,
  TabStatusValue,
  TaskRemoval,
  TunnelConfig,
  TunnelState,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResult,
  WorkspaceListBranchesRequest,
  WindowViewState
} from '../shared/types'
import type { CondaListResult } from '../shared/conda'
import type { NotebookKernelCondaOverride, NotebookKernelEvent } from '../shared/notebook'
import type { AgentActivity } from '../shared/agent-activity'
import type { MobilePairingInvite, MobileState } from '../shared/mobile'
import type { UpdateStatus } from '../shared/updates'
import type { AiStatusEvent } from '../shared/ai-status'
import type { ChatEvent, ChatImage, ChatPromptResponse, ChatSideAnswer, ChatSnapshot } from '../shared/claude-chat'
import type { PermissionBehavior, PermissionSettingsSource, PermissionSourceKind } from '../shared/chat-permissions'

const api = {
  // Projects
  // Projects and notes are revision-guarded: a save quotes the revision it was
  // derived from and main refuses it if another window got there first.
  loadProjects: (): Promise<ProjectsEnvelope> => ipcRenderer.invoke('load-projects'),
  saveProjects: (payload: { baseRevision: number; data: ProjectsData }): Promise<ProjectsSaveResult> =>
    ipcRenderer.invoke('save-projects', payload),
  onProjectsUpdated: (callback: (envelope: ProjectsEnvelope) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, envelope: ProjectsEnvelope) => callback(envelope)
    ipcRenderer.on('projects-updated', handler)
    return () => ipcRenderer.removeListener('projects-updated', handler)
  },

  // Idle task cleanup runs entirely in main — a window only reports what main
  // cannot see (its unsaved buffers) and reacts to what main removed.
  reportDirtyTabs: (tabIds: string[]): Promise<void> => ipcRenderer.invoke('report-dirty-tabs', tabIds),
  /** Status of a tab main has no hooks for (Codex, shells), for the phone's inbox. */
  reportTabStatus: (tabId: string, status: TabStatusValue): Promise<void> => ipcRenderer.invoke('report-tab-status', tabId, status),
  getCleanupActivity: (): Promise<CleanupActivity> => ipcRenderer.invoke('get-cleanup-activity'),
  onTasksRemoved: (callback: (removal: TaskRemoval) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, removal: TaskRemoval) => callback(removal)
    ipcRenderer.on('tasks-removed', handler)
    return () => ipcRenderer.removeListener('tasks-removed', handler)
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

  condaListEnvs: (): Promise<CondaListResult> =>
    ipcRenderer.invoke('conda-list-envs'),

  externalIdeDetect: (): Promise<Array<{ name: string; command: string }>> =>
    ipcRenderer.invoke('external-ide-detect'),
  openInIde: (editorId: string, folder: string): Promise<void> =>
    ipcRenderer.invoke('open-in-ide', editorId, folder),

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
  revealInFolder: (folder: string, relativePath?: string): Promise<void> => ipcRenderer.invoke('reveal-in-folder', folder, relativePath),
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
  hooksInject: (projectDir: string, tabId: string): Promise<void> => ipcRenderer.invoke('hooks-inject', projectDir, tabId),
  hooksCleanup: (projectDir: string, tabId: string): Promise<void> => ipcRenderer.invoke('hooks-cleanup', projectDir, tabId),
  hooksCleanupRemote: (projectId: string, sshConfig: SshConfig, remoteDir: string | undefined, tabId: string): Promise<void> =>
    ipcRenderer.invoke('hooks-cleanup-remote', projectId, sshConfig, remoteDir, tabId),

  // Codex session reading
  codexReadSession: (cwd: string, afterTs?: number, projectId?: string, sshConfig?: SshConfig): Promise<{ sessionId: string | null }> =>
    ipcRenderer.invoke('codex-read-session', cwd, afterTs, projectId, sshConfig),

  // Claude session existence check (before spawning with --resume)
  claudeSessionExists: (cwd: string, sessionId: string, projectId?: string, sshConfig?: SshConfig): Promise<boolean> =>
    ipcRenderer.invoke('claude-session-exists', cwd, sessionId, projectId, sshConfig),

  // Hook events from server
  onHookSessionStart: (callback: (tabId: string, body: Record<string, unknown>) => void): void => {
    ipcRenderer.on('hook-session-start', (_e, tabId, body) => callback(tabId, body))
  },
  onHookWorking: (callback: (tabId: string) => void): void => {
    ipcRenderer.on('hook-working', (_e, tabId) => callback(tabId))
  },
  onHookStopped: (callback: (tabId: string) => void): void => {
    ipcRenderer.on('hook-stopped', (_e, tabId) => callback(tabId))
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
  chatPermissionsRead: (cwd: string): Promise<PermissionSettingsSource[]> => ipcRenderer.invoke('chat-permissions-read', cwd),
  chatPermissionsUpdate: (
    cwd: string,
    kind: PermissionSourceKind,
    behavior: PermissionBehavior,
    rule: string,
    action: 'add' | 'remove'
  ): Promise<void> => ipcRenderer.invoke('chat-permissions-update', cwd, kind, behavior, rule, action),
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
  fbReadDirectory: (projectCwd: string, relativeDirPath: string): Promise<DirectoryEntry[]> =>
    ipcRenderer.invoke('fb-read-directory', projectCwd, relativeDirPath),
  fbReadFile: (projectCwd: string, relativeFilePath: string): Promise<string> =>
    ipcRenderer.invoke('fb-read-file', projectCwd, relativeFilePath),
  fbWriteFile: (projectCwd: string, relativeFilePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('fb-write-file', projectCwd, relativeFilePath, content),
  fbCreateFile: (projectCwd: string, parentRelativePath: string, name: string): Promise<DirectoryEntry> =>
    ipcRenderer.invoke('fb-create-file', projectCwd, parentRelativePath, name),
  fbCreateDirectory: (projectCwd: string, parentRelativePath: string, name: string): Promise<DirectoryEntry> =>
    ipcRenderer.invoke('fb-create-directory', projectCwd, parentRelativePath, name),
  fbRename: (projectCwd: string, fromRelativePath: string, newName: string): Promise<DirectoryEntry> =>
    ipcRenderer.invoke('fb-rename', projectCwd, fromRelativePath, newName),
  fbDelete: (projectCwd: string, relativePath: string): Promise<void> =>
    ipcRenderer.invoke('fb-delete', projectCwd, relativePath),
  fbGitStatus: (projectCwd: string): Promise<GitStatusResult> =>
    ipcRenderer.invoke('fb-git-status', projectCwd),
  gitProjectPosture: (projectCwd: string): Promise<GitPostureResult> =>
    ipcRenderer.invoke('git-project-posture', projectCwd),
  gitCommitHistory: (projectCwd: string): Promise<CommitHistoryResult> =>
    ipcRenderer.invoke('git-commit-history', projectCwd),
  fbGitDiff: (projectCwd: string, relativeFilePath: string): Promise<string> =>
    ipcRenderer.invoke('fb-git-diff', projectCwd, relativeFilePath),
  fbGitStage: (projectCwd: string, files: string[]): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-stage', projectCwd, files),
  fbGitUnstage: (projectCwd: string, files: string[]): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-unstage', projectCwd, files),
  fbGitDiscard: (projectCwd: string, files: string[]): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-discard', projectCwd, files),
  fbGitPull: (projectCwd: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-pull', projectCwd),
  fbGitCommit: (projectCwd: string, message: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-commit', projectCwd, message),
  fbGitPush: (projectCwd: string): Promise<GitOperationResult> =>
    ipcRenderer.invoke('fb-git-push', projectCwd),

  // Menu: file browser toggle
  onMenuToggleFileBrowser: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-toggle-file-browser', handler)
    return () => ipcRenderer.removeListener('menu-toggle-file-browser', handler)
  },

  // Workspaces
  workspaceListBranches: (request: WorkspaceListBranchesRequest): Promise<string[]> =>
    ipcRenderer.invoke('workspace-list-branches', request),
  workspaceCreate: (request: WorkspaceCreateRequest): Promise<{
    worktreePath: string
    branchName: string
    baseBranch: string
    relativeProjectPath: string
  }> => ipcRenderer.invoke('workspace-create', request),
  workspaceDelete: (request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteResult> =>
    ipcRenderer.invoke('workspace-delete', request),

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

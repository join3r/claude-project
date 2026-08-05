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
  TaskRemoval,
  TunnelConfig,
  TunnelState,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResult,
  WorkspaceListBranchesRequest,
  WindowViewState
} from '../shared/types'

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
    ipcRenderer.invoke('workspace-delete', request)
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api

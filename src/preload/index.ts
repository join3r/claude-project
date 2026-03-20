import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  DirectoryEntry,
  GitStatusResult,
  ProjectsData,
  SshConfig,
  TunnelConfig,
  TunnelState,
  WindowViewState
} from '../shared/types'

const api = {
  // Projects
  loadProjects: (): Promise<ProjectsData> => ipcRenderer.invoke('load-projects'),
  saveProjects: (data: ProjectsData): Promise<void> => ipcRenderer.invoke('save-projects', data),
  onProjectsUpdated: (callback: (data: ProjectsData) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ProjectsData) => callback(data)
    ipcRenderer.on('projects-updated', handler)
    return () => ipcRenderer.removeListener('projects-updated', handler)
  },

  // Config
  loadConfig: (): Promise<AppConfig> => ipcRenderer.invoke('load-config'),
  saveConfig: (config: AppConfig): Promise<void> => ipcRenderer.invoke('save-config', config),
  onConfigUpdated: (callback: (config: AppConfig) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, config: AppConfig) => callback(config)
    ipcRenderer.on('config-updated', handler)
    return () => ipcRenderer.removeListener('config-updated', handler)
  },

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

  // Theme
  getNativeTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('get-native-theme'),
  onThemeChanged: (callback: (theme: 'dark' | 'light') => void): void => {
    ipcRenderer.on('theme-changed', (_e, theme) => callback(theme))
  },

  // Scrollback
  scrollbackSave: (tabId: string, data: string): Promise<void> => ipcRenderer.invoke('scrollback-save', tabId, data),
  scrollbackSaveSync: (tabId: string, data: string): void => { ipcRenderer.sendSync('scrollback-save-sync', tabId, data) },
  scrollbackLoad: (tabId: string): Promise<string | null> => ipcRenderer.invoke('scrollback-load', tabId),
  scrollbackDelete: (tabId: string): Promise<void> => ipcRenderer.invoke('scrollback-delete', tabId),

  // Hook injection
  hooksInject: (projectDir: string): Promise<void> => ipcRenderer.invoke('hooks-inject', projectDir),
  hooksCleanup: (projectDir: string): Promise<void> => ipcRenderer.invoke('hooks-cleanup', projectDir),
  hooksCleanupRemote: (projectId: string, sshConfig: SshConfig): Promise<void> =>
    ipcRenderer.invoke('hooks-cleanup-remote', projectId, sshConfig),

  // Codex session reading
  codexReadSession: (cwd: string, afterTs?: number, projectId?: string, sshConfig?: SshConfig): Promise<{ sessionId: string | null }> =>
    ipcRenderer.invoke('codex-read-session', cwd, afterTs, projectId, sshConfig),

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

  // File browser
  fbReadDirectory: (projectCwd: string, relativeDirPath: string): Promise<DirectoryEntry[]> =>
    ipcRenderer.invoke('fb-read-directory', projectCwd, relativeDirPath),
  fbReadFile: (projectCwd: string, relativeFilePath: string): Promise<string> =>
    ipcRenderer.invoke('fb-read-file', projectCwd, relativeFilePath),
  fbWriteFile: (projectCwd: string, relativeFilePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('fb-write-file', projectCwd, relativeFilePath, content),
  fbGitStatus: (projectCwd: string): Promise<GitStatusResult> =>
    ipcRenderer.invoke('fb-git-status', projectCwd),
  fbGitDiff: (projectCwd: string, relativeFilePath: string): Promise<string> =>
    ipcRenderer.invoke('fb-git-diff', projectCwd, relativeFilePath),

  // Menu: file browser toggle
  onMenuToggleFileBrowser: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('menu-toggle-file-browser', handler)
    return () => ipcRenderer.removeListener('menu-toggle-file-browser', handler)
  },

  // Workspaces
  workspaceListBranches: (projectDir: string): Promise<string[]> =>
    ipcRenderer.invoke('workspace-list-branches', projectDir),
  workspaceCreate: (projectDir: string, name: string, baseBranch: string): Promise<{
    worktreePath: string
    branchName: string
    baseBranch: string
    relativeProjectPath: string
  }> => ipcRenderer.invoke('workspace-create', projectDir, name, baseBranch),
  workspaceDelete: (
    projectDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
    force?: boolean,
    keepBranch?: boolean
  ): Promise<{ status: 'ok' | 'uncommitted' | 'unmerged' | 'uncommitted-and-unmerged'; baseBranch?: string }> =>
    ipcRenderer.invoke('workspace-delete', projectDir, worktreePath, branchName, baseBranch, force, keepBranch)
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api

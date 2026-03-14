import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, ProjectsData, SshConfig } from '../shared/types'

const api = {
  // Projects
  loadProjects: (): Promise<ProjectsData> => ipcRenderer.invoke('load-projects'),
  saveProjects: (data: ProjectsData): Promise<void> => ipcRenderer.invoke('save-projects', data),

  // Config
  loadConfig: (): Promise<AppConfig> => ipcRenderer.invoke('load-config'),
  saveConfig: (config: AppConfig): Promise<void> => ipcRenderer.invoke('save-config', config),

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

  // Workspace
  workspaceListBranches: (projectDir: string): Promise<string[]> =>
    ipcRenderer.invoke('workspace-list-branches', projectDir),
  workspaceCreate: (projectDir: string, name: string, baseBranch: string): Promise<{ worktreePath: string; branchName: string; relativeProjectPath: string }> =>
    ipcRenderer.invoke('workspace-create', projectDir, name, baseBranch),
  workspaceDelete: (projectDir: string, worktreePath: string, branchName: string, baseBranch: string, force?: boolean, keepBranch?: boolean): Promise<{ status: 'ok' | 'uncommitted' | 'unmerged' | 'uncommitted-and-unmerged'; baseBranch?: string }> =>
    ipcRenderer.invoke('workspace-delete', projectDir, worktreePath, branchName, baseBranch, force, keepBranch),

  // Codex session isolation
  codexPrepare: (tabId: string, projectId?: string, sshConfig?: SshConfig): Promise<{ home: string; sessionId: string | null }> =>
    ipcRenderer.invoke('codex-prepare', tabId, projectId, sshConfig),
  codexReadSession: (tabId: string, projectId?: string, sshConfig?: SshConfig): Promise<{ sessionId: string | null }> =>
    ipcRenderer.invoke('codex-read-session', tabId, projectId, sshConfig),
  codexCleanup: (tabId: string): Promise<void> => ipcRenderer.invoke('codex-cleanup', tabId),
  codexCleanupRemote: (tabId: string, projectId: string, sshConfig: SshConfig): Promise<void> =>
    ipcRenderer.invoke('codex-cleanup-remote', tabId, projectId, sshConfig),

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
  ptySpawn: (id: string, shell: string, cwd: string, cols: number, rows: number, args?: string[], extraEnv?: Record<string, string>, projectId?: string, sshConfig?: SshConfig): Promise<void> =>
    ipcRenderer.invoke('pty-spawn', id, shell, cwd, cols, rows, args, extraEnv, projectId, sshConfig),
  ptyWrite: (id: string, data: string): void => ipcRenderer.send('pty-write', id, data),
  ptyResize: (id: string, cols: number, rows: number): void => ipcRenderer.send('pty-resize', id, cols, rows),
  ptyKill: (id: string): void => ipcRenderer.send('pty-kill', id),
  onPtyData: (callback: (id: string, data: string) => void): void => {
    ipcRenderer.on('pty-data', (_e, id, data) => callback(id, data))
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
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api

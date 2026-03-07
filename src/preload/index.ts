import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, ProjectsData } from '../shared/types'

const api = {
  // Projects
  loadProjects: (): Promise<ProjectsData> => ipcRenderer.invoke('load-projects'),
  saveProjects: (data: ProjectsData): Promise<void> => ipcRenderer.invoke('save-projects', data),

  // Config
  loadConfig: (): Promise<AppConfig> => ipcRenderer.invoke('load-config'),
  saveConfig: (config: AppConfig): Promise<void> => ipcRenderer.invoke('save-config', config),

  // Directory picker
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('pick-directory'),

  // Theme
  getNativeTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('get-native-theme'),
  onThemeChanged: (callback: (theme: 'dark' | 'light') => void): void => {
    ipcRenderer.on('theme-changed', (_e, theme) => callback(theme))
  },

  // PTY
  ptySpawn: (id: string, shell: string, cwd: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('pty-spawn', id, shell, cwd, cols, rows),
  ptyWrite: (id: string, data: string): void => ipcRenderer.send('pty-write', id, data),
  ptyResize: (id: string, cols: number, rows: number): void => ipcRenderer.send('pty-resize', id, cols, rows),
  ptyKill: (id: string): void => ipcRenderer.send('pty-kill', id),
  onPtyData: (callback: (id: string, data: string) => void): void => {
    ipcRenderer.on('pty-data', (_e, id, data) => callback(id, data))
  },
  onPtyExit: (callback: (id: string, exitCode: number) => void): void => {
    ipcRenderer.on('pty-exit', (_e, id, exitCode) => callback(id, exitCode))
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api

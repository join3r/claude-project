import { ipcMain, dialog, BrowserWindow, nativeTheme } from 'electron'
import { Storage } from './storage'
import { PtyManager } from './pty-manager'
import { AppConfig, ProjectsData } from '../shared/types'
import os from 'os'
import path from 'path'

const CONFIG_DIR = path.join(os.homedir(), '.devtool')

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const storage = new Storage(CONFIG_DIR)
  const ptyManager = new PtyManager()

  // Projects
  ipcMain.handle('load-projects', () => storage.loadProjects())
  ipcMain.handle('save-projects', (_e, data: ProjectsData) => storage.saveProjects(data))

  // Config
  ipcMain.handle('load-config', () => storage.loadConfig())
  ipcMain.handle('save-config', (_e, config: AppConfig) => storage.saveConfig(config))

  // Directory picker
  ipcMain.handle('pick-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Theme
  ipcMain.handle('get-native-theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  nativeTheme.on('updated', () => {
    mainWindow.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  })

  // PTY
  ipcMain.handle('pty-spawn', (_e, id: string, shell: string, cwd: string, cols: number, rows: number) => {
    ptyManager.spawn(id, shell, cwd, cols, rows)
    ptyManager.onData(id, (data) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('pty-data', id, data)
    })
    ptyManager.onExit(id, (exitCode) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('pty-exit', id, exitCode)
    })
  })

  ipcMain.on('pty-write', (_e, id: string, data: string) => {
    ptyManager.write(id, data)
  })

  ipcMain.on('pty-resize', (_e, id: string, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows)
  })

  ipcMain.on('pty-kill', (_e, id: string) => {
    ptyManager.kill(id)
  })

  // Cleanup on close
  mainWindow.on('closed', () => {
    ptyManager.killAll()
  })
}

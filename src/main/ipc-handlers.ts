import { ipcMain, dialog, BrowserWindow, nativeTheme } from 'electron'
import { Storage } from './storage'
import { ScrollbackStorage } from './scrollback-storage'
import { PtyManager } from './pty-manager'
import { HookServer } from './hook-server'
import { HookInjector } from './hook-injector'
import { AppConfig, ProjectsData } from '../shared/types'
import os from 'os'
import path from 'path'

const CONFIG_DIR = path.join(os.homedir(), '.devtool')

export async function registerIpcHandlers(mainWindow: BrowserWindow): Promise<{ cleanup: () => void }> {
  const storage = new Storage(CONFIG_DIR)
  const scrollbackStorage = new ScrollbackStorage(path.join(CONFIG_DIR, 'scrollback'))
  const ptyManager = new PtyManager()

  // Start hook server BEFORE registering IPC handlers — no race condition
  const hookServer = new HookServer()
  await hookServer.start()
  const hookInjector = new HookInjector(hookServer.getPort())

  // Hook server events → renderer
  hookServer.on('session-start', (tabId: string, body: Record<string, unknown>) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hook-session-start', tabId, body)
    }
  })

  hookServer.on('working', (tabId: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hook-working', tabId)
    }
  })

  hookServer.on('stopped', (tabId: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hook-stopped', tabId)
    }
  })

  hookServer.on('notification', (tabId: string, body: Record<string, unknown>) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hook-notification', tabId, body)
    }
  })

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

  // Scrollback — async save for normal use
  ipcMain.handle('scrollback-save', (_e, tabId: string, data: string) => {
    scrollbackStorage.save(tabId, data)
  })
  ipcMain.handle('scrollback-load', (_e, tabId: string) => {
    return scrollbackStorage.load(tabId)
  })
  ipcMain.handle('scrollback-delete', (_e, tabId: string) => {
    scrollbackStorage.delete(tabId)
  })

  // Scrollback — synchronous save for beforeunload reliability
  ipcMain.on('scrollback-save-sync', (e, tabId: string, data: string) => {
    scrollbackStorage.save(tabId, data)
    e.returnValue = true
  })

  // Hook injection
  ipcMain.handle('hooks-inject', (_e, projectDir: string) => {
    hookInjector.inject(projectDir)
  })
  ipcMain.handle('hooks-cleanup', (_e, projectDir: string) => {
    hookInjector.cleanup(projectDir)
  })

  // PTY — accepts args array and extraEnv
  ipcMain.handle('pty-spawn', (_e, id: string, shell: string, cwd: string, cols: number, rows: number, args?: string[], extraEnv?: Record<string, string>) => {
    ptyManager.spawn(id, shell, cwd, cols, rows, args, extraEnv)
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

  // Cleanup
  const cleanup = (): void => {
    ptyManager.killAll()
    hookInjector.cleanupAll()
    hookServer.stop()
  }

  mainWindow.on('closed', cleanup)

  return { cleanup }
}

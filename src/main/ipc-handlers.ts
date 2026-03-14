import { ipcMain, dialog, BrowserWindow, nativeTheme } from 'electron'
import { Storage } from './storage'
import { ScrollbackStorage } from './scrollback-storage'
import { PtyManager } from './pty-manager'
import { HookServer } from './hook-server'
import { HookInjector } from './hook-injector'
import { SshConnectionManager } from './ssh-connection-manager'
import type { SshConfig } from '../shared/types'
import { AppConfig, ProjectsData } from '../shared/types'
import { WorkspaceManager } from './workspace-manager'
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
  const workspaceManager = new WorkspaceManager()

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

  // SSH
  const sshDir = path.join(CONFIG_DIR, 'ssh')
  const sshManager = new SshConnectionManager(sshDir, hookServer.getPort())

  sshManager.on('status-changed', (projectId: string, status: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ssh-status-changed', projectId, status)
    }
  })

  ipcMain.handle('ssh-connect', async (_e, projectId: string, sshConfig: SshConfig) => {
    await sshManager.connect(projectId, sshConfig)
    sshManager.startHealthChecks(projectId, sshConfig)
  })

  ipcMain.handle('ssh-disconnect', async (_e, projectId: string, sshConfig: SshConfig) => {
    await sshManager.disconnect(projectId, sshConfig)
  })

  ipcMain.handle('ssh-status', (_e, projectId: string) => {
    return sshManager.getStatus(projectId)
  })

  // File picker (for SSH key selection)
  ipcMain.handle('pick-file', async (_e, title?: string) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Select file',
      properties: ['openFile', 'showHiddenFiles']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Hook injection
  ipcMain.handle('hooks-inject', (_e, projectDir: string) => {
    hookInjector.inject(projectDir)
  })
  ipcMain.handle('hooks-cleanup', (_e, projectDir: string) => {
    hookInjector.cleanup(projectDir)
  })
  ipcMain.handle('hooks-cleanup-remote', async (_e, projectId: string, sshConfig: SshConfig) => {
    const isLast = hookInjector.remoteCleanup(projectId)
    if (!isLast) return

    if (sshManager.getStatus(projectId) !== 'connected') return
    const cleanupScript = hookInjector.buildRemoteCleanupScript(sshConfig.remoteDir)
    const cleanupArgs = [
      '-S', sshManager.getSocketPath(projectId),
      `${sshConfig.username}@${sshConfig.host}`,
      cleanupScript
    ]
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      await promisify(execFile)('ssh', cleanupArgs, { timeout: 5000 })
    } catch {
      // Best-effort cleanup
    }
  })

  // Workspace
  ipcMain.handle('workspace-list-branches', async (_e, projectDir: string) => {
    return workspaceManager.listBranches(projectDir)
  })

  ipcMain.handle('workspace-create', async (_e, projectDir: string, name: string, baseBranch: string) => {
    return workspaceManager.create(projectDir, name, baseBranch)
  })

  ipcMain.handle('workspace-delete', async (_e, projectDir: string, worktreePath: string, branchName: string, baseBranch: string, force?: boolean, keepBranch?: boolean) => {
    return workspaceManager.delete({ projectDir, worktreePath, branchName, baseBranch, force, keepBranch })
  })

  // PTY — accepts args array, extraEnv, and optional SSH config for remote spawn
  ipcMain.handle('pty-spawn', (_e, id: string, shell: string, cwd: string, cols: number, rows: number, args?: string[], extraEnv?: Record<string, string>, projectId?: string, sshConfig?: SshConfig) => {
    if (sshConfig && projectId) {
      // Remote spawn via SSH
      if (sshManager.getStatus(projectId) !== 'connected') {
        throw new Error('SSH connection not established')
      }

      // For Claude tabs on remote, inject hooks via the spawn command (ref-counted)
      const isClaudeRemote = shell === 'claude' && extraEnv?.DEVTOOL_TAB_ID
      let hookInjectPrefix = ''
      if (isClaudeRemote) {
        const remotePort = sshManager.getRemotePort(projectId)
        if (remotePort) {
          hookInjector.remoteInject(projectId)
          hookInjectPrefix = hookInjector.buildRemoteInjectScript(sshConfig.remoteDir, remotePort) + ' && '
        }
      }

      const sshArgs = sshManager.buildSpawnArgs(projectId, sshConfig, shell, args, extraEnv, hookInjectPrefix)
      ptyManager.spawn(id, 'ssh', os.tmpdir(), cols, rows, sshArgs)
    } else {
      // Local spawn (existing behavior)
      ptyManager.spawn(id, shell, cwd, cols, rows, args, extraEnv)
    }
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
    sshManager.disconnectAll().catch(() => {})
  }

  mainWindow.on('closed', cleanup)

  return { cleanup }
}

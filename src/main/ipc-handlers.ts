// Legacy IPC handlers — kept for single-window fallback.
// The primary IPC registration (including pty-spawn) lives in AppRuntime (app-runtime.ts).
import { app, ipcMain, dialog, BrowserWindow, nativeTheme } from 'electron'
import { Storage } from './storage'
import { ScrollbackStorage } from './scrollback-storage'
import { PtyManager } from './pty-manager'
import { HookServer } from './hook-server'
import { HookInjector } from './hook-injector'
import { SshConnectionManager } from './ssh-connection-manager'
import { CodexSessionManager } from './codex-session-manager'
import type { SshConfig, ProjectNote, GitPostureResult, GitPostureLastCommit, CommitHistoryResult } from '../shared/types'
import { AppConfig, ProjectsData } from '../shared/types'
import { NotesStorage } from './notes-storage'
import { PaletteFrecencyStorage, type FrecencyFile } from './palette-frecency-storage'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const CONFIG_DIR = path.join(os.homedir(), '.devtool')

export async function registerIpcHandlers(mainWindow: BrowserWindow): Promise<{ cleanup: () => void }> {
  const storage = new Storage(CONFIG_DIR)
  const scrollbackStorage = new ScrollbackStorage(path.join(CONFIG_DIR, 'scrollback'))
  const ptyManager = new PtyManager()

  // Start hook server BEFORE registering IPC handlers — no race condition
  const hookServer = new HookServer()
  await hookServer.start()
  const hookInjector = new HookInjector(hookServer.getPort())
  const codexSessionManager = new CodexSessionManager()

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
  ipcMain.handle('app:open-devtools', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools()
  })
  ipcMain.handle('app:quit', () => app.quit())
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

  // Notes
  const notesStorage = new NotesStorage(CONFIG_DIR)
  ipcMain.handle('notes-load', () => notesStorage.load())
  ipcMain.handle('notes-save', (_e, data: Record<string, ProjectNote[]>) => notesStorage.save(data))

  // Palette frecency
  const paletteFrecency = new PaletteFrecencyStorage(CONFIG_DIR)
  ipcMain.handle('palette-frecency:load', () => paletteFrecency.load())
  ipcMain.handle('palette-frecency:save', (_e, file: FrecencyFile) => paletteFrecency.save(file))

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

  ipcMain.handle('git-project-posture', async (_event, projectCwd: string): Promise<GitPostureResult> => {
    const resolvedCwd = path.resolve(projectCwd)
    const empty: GitPostureResult = {
      isGitRepo: false, branch: null, upstream: null,
      ahead: 0, behind: 0, dirtyCount: 0, lastCommit: null
    }
    try {
      const { stdout } = await execFileAsync(
        'git', ['status', '--porcelain=v2', '--branch'],
        { cwd: resolvedCwd }
      )
      let branch: string | null = null
      let upstream: string | null = null
      let ahead = 0
      let behind = 0
      let dirtyCount = 0
      for (const line of stdout.split('\n')) {
        if (!line) continue
        if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim()
        else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim()
        else if (line.startsWith('# branch.ab ')) {
          const m = line.match(/\+(\d+)\s+-(\d+)/)
          if (m) { ahead = Number(m[1]); behind = Number(m[2]) }
        } else if (!line.startsWith('#')) {
          dirtyCount += 1
        }
      }
      let lastCommit: GitPostureLastCommit | null = null
      try {
        const { stdout: logOut } = await execFileAsync(
          'git', ['log', '-1', '--format=%H%x00%s%x00%an%x00%cI'],
          { cwd: resolvedCwd }
        )
        const trimmed = logOut.replace(/\n+$/, '')
        if (trimmed) {
          const [sha, subject, author, isoDate] = trimmed.split('\x00')
          if (sha) lastCommit = { sha, subject: subject ?? '', author: author ?? '', isoDate: isoDate ?? '' }
        }
      } catch { /* repo with zero commits */ }
      return { isGitRepo: true, branch, upstream, ahead, behind, dirtyCount, lastCommit }
    } catch {
      return empty
    }
  })

  ipcMain.handle('git-commit-history', async (_event, projectCwd: string): Promise<CommitHistoryResult> => {
    const resolvedCwd = path.resolve(projectCwd)
    try {
      const { stdout } = await execFileAsync(
        'git', ['log', '--format=%cI'],
        { cwd: resolvedCwd, maxBuffer: 32 * 1024 * 1024 }
      )
      const commits = stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0)
      return { commits }
    } catch {
      return { commits: [] }
    }
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
  ipcMain.handle('hooks-cleanup-remote', async (_e, projectId: string, sshConfig: SshConfig, remoteDir?: string) => {
    const effectiveRemoteDir = remoteDir || sshConfig.remoteDir
    const isLast = hookInjector.remoteCleanup(projectId, effectiveRemoteDir)
    if (!isLast) return

    if (sshManager.getStatus(projectId) !== 'connected') return
    const cleanupScript = hookInjector.buildRemoteCleanupScript(effectiveRemoteDir)
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

  // Codex session reading
  ipcMain.handle('codex-read-session', async (_e, cwd: string, afterTs?: number, projectId?: string, sshConfig?: SshConfig) => {
    if (!sshConfig || !projectId) {
      return { sessionId: await codexSessionManager.readLatestSessionId(cwd, afterTs) }
    }

    if (sshManager.getStatus(projectId) !== 'connected') {
      throw new Error('SSH connection not established')
    }

    const readScript = codexSessionManager.buildRemoteReadSessionScript(cwd, afterTs)
    const sshArgs = [
      '-S', sshManager.getSocketPath(projectId),
      `${sshConfig.username}@${sshConfig.host}`,
      readScript
    ]

    try {
      const { execFile: execFileCb } = await import('child_process')
      const { promisify } = await import('util')
      const { stdout } = await promisify(execFileCb)('ssh', sshArgs, { timeout: 5000 })
      return JSON.parse(stdout.trim()) as { sessionId: string | null }
    } catch (error) {
      throw new Error(`Failed to read Codex session: ${error instanceof Error ? error.message : String(error)}`)
    }
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
      const remoteCwd = cwd || sshConfig.remoteDir
      if (isClaudeRemote) {
        const remotePort = sshManager.getRemotePort(projectId)
        if (remotePort) {
          hookInjector.remoteInject(projectId, remoteCwd)
          hookInjectPrefix = hookInjector.buildRemoteInjectScript(remoteCwd, remotePort) + ' && '
        }
      }

      const sshArgs = sshManager.buildSpawnArgs(projectId, sshConfig, shell, args, extraEnv, hookInjectPrefix, remoteCwd)
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

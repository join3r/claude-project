import { BrowserWindow, dialog, ipcMain, nativeTheme, session } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Storage } from './storage'
import { ScrollbackStorage } from './scrollback-storage'
import { PtyManager } from './pty-manager'
import { HookServer } from './hook-server'
import { HookInjector } from './hook-injector'
import { SshConnectionManager } from './ssh-connection-manager'
import { CodexSessionManager } from './codex-session-manager'
import { WorkspaceManager } from './workspace-manager'
import type {
  AppConfig,
  DirectoryEntry,
  GitStatusResult,
  GitStatusEntry,
  GitFileStatus,
  PersistedWindowState,
  ProjectsData,
  SshConfig,
  TunnelConfig,
  WindowGeometry,
  WindowViewState
} from '../shared/types'
import {
  buildWindowViewState,
  clonePersistedWindowState,
  cloneWindowGeometry,
  cloneWindowViewState
} from '../shared/types'
import fsPromises from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const CONFIG_DIR = path.join(os.homedir(), '.devtool')
const MAX_SCROLLBACK_CHARS = 2_000_000
const DEBUG_LOG_PATH = path.join(CONFIG_DIR, 'debug.log')

interface PtyRuntime {
  attachedWindowIds: Set<number>
  controllerWindowId: number | null
  cols: number
  rows: number
  scrollback: string
  exitCode: number | null
}

interface PtyAttachResult {
  cols: number
  rows: number
  scrollback: string
  exitCode: number | null
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function trimScrollback(scrollback: string): string {
  if (scrollback.length <= MAX_SCROLLBACK_CHARS) return scrollback
  return scrollback.slice(-MAX_SCROLLBACK_CHARS)
}

function getWindowGeometry(window: BrowserWindow): WindowGeometry {
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds()
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: window.isMaximized()
  }
}

export class AppRuntime {
  private readonly storage = new Storage(CONFIG_DIR)
  private readonly scrollbackStorage = new ScrollbackStorage(path.join(CONFIG_DIR, 'scrollback'))
  private readonly ptyManager = new PtyManager()
  private readonly hookServer = new HookServer()
  private readonly codexSessionManager = new CodexSessionManager()
  private readonly workspaceManager = new WorkspaceManager()
  private readonly windows = new Map<number, BrowserWindow>()
  private readonly windowStates = new Map<number, PersistedWindowState>()
  private readonly ptyRuntimes = new Map<string, PtyRuntime>()
  private hookInjector!: HookInjector
  private sshManager!: SshConnectionManager
  private started = false
  private quitting = false
  private socksProxyEnabled = new Map<string, boolean>()
  private socksProxyStarting = new Map<string, Promise<number>>()
  private projectsData: ProjectsData
  private config: AppConfig
  private startupWindowStates: PersistedWindowState[]

  constructor(private readonly createWindow: (viewState?: WindowViewState | null, geometry?: WindowGeometry | null) => BrowserWindow) {
    this.projectsData = this.storage.loadProjects()
    this.config = this.storage.loadConfig()
    this.startupWindowStates = this.storage.loadWindowSession(this.projectsData).windows
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.hookServer.start()
    this.logDebug(`start hookPort=${this.hookServer.getPort()}`)
    this.hookInjector = new HookInjector(this.hookServer.getPort())
    this.sshManager = new SshConnectionManager(path.join(CONFIG_DIR, 'ssh'), this.hookServer.getPort())
    this.registerEventForwarders()
    this.registerIpcHandlers()
  }

  registerWindow(window: BrowserWindow, initialViewState?: WindowViewState | null): void {
    this.windows.set(window.id, window)
    this.windowStates.set(window.id, {
      geometry: getWindowGeometry(window),
      viewState: initialViewState
        ? cloneWindowViewState(initialViewState)
        : buildWindowViewState(this.projectsData.projects, this.config)
    })
    this.logDebug(`registerWindow windowId=${window.id}`)
    const syncGeometry = () => {
      this.updateWindowGeometry(window.id)
    }
    window.on('move', syncGeometry)
    window.on('resize', syncGeometry)
    window.on('maximize', syncGeometry)
    window.on('unmaximize', syncGeometry)
    window.on('closed', () => {
      this.logDebug(`windowClosed windowId=${window.id}`)
      this.windows.delete(window.id)
      if (!this.quitting) {
        this.windowStates.delete(window.id)
        this.persistWindowSession()
      }
      for (const [tabId, runtime] of this.ptyRuntimes.entries()) {
        runtime.attachedWindowIds.delete(window.id)
        if (runtime.controllerWindowId === window.id) {
          const nextController = runtime.attachedWindowIds.values().next().value ?? null
          runtime.controllerWindowId = nextController
          this.logDebug(`ptyControllerReassigned id=${tabId} windowId=${nextController ?? 'none'}`)
        }
      }
    })
  }

  getStartupWindowStates(): PersistedWindowState[] {
    return this.startupWindowStates.map((state) => clonePersistedWindowState(state))
  }

  prepareForQuit(): void {
    this.quitting = true
  }

  async shutdown(): Promise<void> {
    this.persistWindowSession()
    this.ptyManager.killAll()
    this.hookInjector.cleanupAll()
    await this.hookServer.stop()
    await this.sshManager.disconnectAll().catch(() => {})
  }

  private registerEventForwarders(): void {
    this.hookServer.on('session-start', (tabId: string, body: Record<string, unknown>) => {
      this.broadcastToAttachedWindows(tabId, 'hook-session-start', tabId, body)
    })

    this.hookServer.on('working', (tabId: string) => {
      this.broadcastToAttachedWindows(tabId, 'hook-working', tabId)
    })

    this.hookServer.on('stopped', (tabId: string) => {
      this.broadcastToAttachedWindows(tabId, 'hook-stopped', tabId)
    })

    this.hookServer.on('notification', (tabId: string, body: Record<string, unknown>) => {
      this.broadcastToAttachedWindows(tabId, 'hook-notification', tabId, body)
    })

    this.sshManager.on('status-changed', async (projectId: string, status: string) => {
      this.logDebug(`sshStatus projectId=${projectId} status=${status}`)
      this.broadcastToAllWindows('ssh-status-changed', projectId, status)

      if (status === 'disconnected' && this.socksProxyEnabled.get(projectId)) {
        const ses = session.fromPartition(`persist:browser-${projectId}`)
        await ses.setProxy({ proxyRules: 'direct://' }).catch(() => {})
        await ses.closeAllConnections().catch(() => {})
        this.broadcastToAllWindows('socks-proxy-status-changed', projectId, false)
      }
    })

    this.sshManager.on('tunnel-status-changed', (projectId: string, status: string, error?: string) => {
      this.logDebug(`tunnelStatus projectId=${projectId} status=${status}${error ? ` error=${error}` : ''}`)
      this.broadcastToAllWindows('ssh-tunnel-status-changed', projectId, status, error)
    })

    this.sshManager.on('socks-proxy-status-changed', async (projectId: string, enabled: boolean) => {
      if (!enabled) {
        const ses = session.fromPartition(`persist:browser-${projectId}`)
        await ses.setProxy({ proxyRules: 'direct://' }).catch(() => {})
        await ses.closeAllConnections().catch(() => {})
        this.broadcastToAllWindows('socks-proxy-status-changed', projectId, false)

        const config = this.sshManager.getConfig(projectId)
        if (this.socksProxyEnabled.get(projectId) && config && this.sshManager.getStatus(projectId) === 'connected') {
          try {
            const port = await this.sshManager.startSocksProxy(projectId, config)
            await ses.setProxy({
              proxyRules: `socks5://127.0.0.1:${port}`,
              proxyBypassRules: '<-loopback>'
            })
            await ses.closeAllConnections()
            this.broadcastToAllWindows('socks-proxy-status-changed', projectId, true, port)
          } catch {
            // Auto-restart failed — stay in direct mode
          }
        }
      }
    })

    nativeTheme.on('updated', () => {
      this.broadcastToAllWindows('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    })
  }

  private registerIpcHandlers(): void {
    ipcMain.handle('load-projects', () => clone(this.projectsData))
    ipcMain.handle('save-projects', (event, data: ProjectsData) => {
      this.projectsData = Storage.normalizeProjectsData(data as unknown as Record<string, unknown>)
      this.storage.saveProjects(this.projectsData)
      this.broadcastToAllWindows('projects-updated', clone(this.projectsData))
      return undefined
    })

    ipcMain.handle('load-config', () => clone(this.config))
    ipcMain.handle('save-config', (_event, config: AppConfig) => {
      this.config = { ...this.config, ...config }
      this.storage.saveConfig(this.config)
      this.broadcastToAllWindows('config-updated', clone(this.config))
      return undefined
    })

    ipcMain.handle('load-window-state', (event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const state = window ? this.windowStates.get(window.id) ?? null : null
      return state
        ? cloneWindowViewState(state.viewState)
        : buildWindowViewState(this.projectsData.projects, this.config)
    })

    ipcMain.handle('save-window-state', (event, viewState: WindowViewState) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return undefined
      const current = this.windowStates.get(window.id)
      this.windowStates.set(window.id, {
        geometry: current ? cloneWindowGeometry(current.geometry) : getWindowGeometry(window),
        viewState: cloneWindowViewState(viewState)
      })
      this.persistWindowSession()
      return undefined
    })

    ipcMain.handle('open-window', (_event, viewState?: WindowViewState | null) => {
      this.logDebug(`openWindow seeded=${viewState ? 'yes' : 'no'}`)
      this.createWindow(viewState ?? null, null)
    })

    ipcMain.handle('pick-directory', async (event) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const result = await dialog.showOpenDialog(owner, {
        properties: ['openDirectory']
      })
      return result.canceled ? null : result.filePaths[0]
    })

    ipcMain.handle('pick-file', async (event, title?: string) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const result = await dialog.showOpenDialog(owner, {
        title: title || 'Select file',
        properties: ['openFile', 'showHiddenFiles']
      })
      return result.canceled ? null : result.filePaths[0]
    })

    ipcMain.handle('get-native-theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light')

    ipcMain.handle('scrollback-save', (_event, tabId: string, data: string) => {
      const scrollback = trimScrollback(data)
      this.scrollbackStorage.save(tabId, scrollback)
      const runtime = this.ptyRuntimes.get(tabId)
      if (runtime) runtime.scrollback = scrollback
      return undefined
    })
    ipcMain.handle('scrollback-load', (_event, tabId: string) => {
      const runtime = this.ptyRuntimes.get(tabId)
      return runtime ? runtime.scrollback : this.scrollbackStorage.load(tabId)
    })
    ipcMain.handle('scrollback-delete', (_event, tabId: string) => {
      this.scrollbackStorage.delete(tabId)
      return undefined
    })
    ipcMain.on('scrollback-save-sync', (event, tabId: string, data: string) => {
      const scrollback = trimScrollback(data)
      this.scrollbackStorage.save(tabId, scrollback)
      const runtime = this.ptyRuntimes.get(tabId)
      if (runtime) runtime.scrollback = scrollback
      event.returnValue = true
    })

    ipcMain.handle('ssh-connect', async (_event, projectId: string, sshConfig: SshConfig) => {
      await this.sshManager.connect(projectId, sshConfig)
      this.sshManager.startHealthChecks(projectId, sshConfig)
      const tunnel = this.getProjectTunnel(projectId)
      if (tunnel) {
        try {
          await this.sshManager.setTunnel(projectId, sshConfig, tunnel)
        } catch {
          // Keep SSH connected even when restoring the tunnel fails.
        }
      }
      if (this.socksProxyEnabled.get(projectId)) {
        try {
          const port = await this.sshManager.startSocksProxy(projectId, sshConfig)
          const ses = session.fromPartition(`persist:browser-${projectId}`)
          await ses.setProxy({
            proxyRules: `socks5://127.0.0.1:${port}`,
            proxyBypassRules: '<-loopback>'
          })
          await ses.closeAllConnections()
          this.broadcastToAllWindows('socks-proxy-status-changed', projectId, true, port)
        } catch {
          // Keep SSH connected even when restoring SOCKS proxy fails.
        }
      }
    })

    ipcMain.handle('ssh-disconnect', async (_event, projectId: string, sshConfig: SshConfig) => {
      // Reset session proxy before disconnect since stopSocksProxy suppresses the exit event
      if (this.socksProxyEnabled.get(projectId)) {
        const ses = session.fromPartition(`persist:browser-${projectId}`)
        await ses.setProxy({ proxyRules: 'direct://' }).catch(() => {})
        await ses.closeAllConnections().catch(() => {})
        this.broadcastToAllWindows('socks-proxy-status-changed', projectId, false)
      }
      await this.sshManager.disconnect(projectId, sshConfig)
    })

    ipcMain.handle('ssh-status', (_event, projectId: string) => {
      return this.sshManager.getStatus(projectId)
    })

    ipcMain.handle('ssh-set-tunnel', async (_event, projectId: string, sshConfig: SshConfig, tunnel: TunnelConfig | null) => {
      await this.sshManager.setTunnel(projectId, sshConfig, tunnel)
    })

    ipcMain.handle('ssh-tunnel-status', (_event, projectId: string) => {
      return clone(this.sshManager.getTunnelState(projectId))
    })

    ipcMain.handle('socks-proxy-enable', async (_event, projectId: string, sshConfig: SshConfig) => {
      this.socksProxyEnabled.set(projectId, true)

      const pending = this.socksProxyStarting.get(projectId)
      if (pending) {
        const port = await pending
        return { port }
      }

      const startPromise = (async () => {
        const port = await this.sshManager.startSocksProxy(projectId, sshConfig)
        // Re-check desired state after async startup — a disable may have raced us
        if (!this.socksProxyEnabled.get(projectId)) {
          await this.sshManager.stopSocksProxy(projectId)
          throw new Error('SOCKS proxy was disabled during startup')
        }
        const ses = session.fromPartition(`persist:browser-${projectId}`)
        await ses.setProxy({
          proxyRules: `socks5://127.0.0.1:${port}`,
          proxyBypassRules: '<-loopback>'
        })
        await ses.closeAllConnections()
        this.broadcastToAllWindows('socks-proxy-status-changed', projectId, true, port)
        return port
      })()

      this.socksProxyStarting.set(projectId, startPromise)
      try {
        const port = await startPromise
        return { port }
      } catch (err) {
        this.socksProxyEnabled.set(projectId, false)
        throw err
      } finally {
        this.socksProxyStarting.delete(projectId)
      }
    })

    ipcMain.handle('socks-proxy-disable', async (_event, projectId: string) => {
      this.socksProxyEnabled.set(projectId, false)
      await this.sshManager.stopSocksProxy(projectId)
      const ses = session.fromPartition(`persist:browser-${projectId}`)
      await ses.setProxy({ proxyRules: 'direct://' })
      await ses.closeAllConnections()
      this.broadcastToAllWindows('socks-proxy-status-changed', projectId, false)
    })

    ipcMain.handle('socks-proxy-status', (_event, projectId: string) => {
      const hasEntry = this.socksProxyEnabled.has(projectId)
      const enabled = hasEntry ? this.socksProxyEnabled.get(projectId)! : undefined
      const proxy = this.sshManager.getSocksProxy(projectId)
      return { enabled, port: proxy?.port }
    })

    ipcMain.handle('hooks-inject', (_event, projectDir: string) => {
      this.hookInjector.inject(projectDir)
    })
    ipcMain.handle('hooks-cleanup', (_event, projectDir: string) => {
      this.hookInjector.cleanup(projectDir)
    })
    ipcMain.handle('hooks-cleanup-remote', async (_event, projectId: string, sshConfig: SshConfig) => {
      const isLast = this.hookInjector.remoteCleanup(projectId)
      if (!isLast) return

      if (this.sshManager.getStatus(projectId) !== 'connected') return
      const cleanupScript = this.hookInjector.buildRemoteCleanupScript(sshConfig.remoteDir)
      const cleanupArgs = [
        '-S', this.sshManager.getSocketPath(projectId),
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

    ipcMain.handle('codex-read-session', async (_event, cwd: string, afterTs?: number, projectId?: string, sshConfig?: SshConfig) => {
      if (!sshConfig || !projectId) {
        return { sessionId: await this.codexSessionManager.readLatestSessionId(cwd, afterTs) }
      }

      if (this.sshManager.getStatus(projectId) !== 'connected') {
        throw new Error('SSH connection not established')
      }

      const readScript = this.codexSessionManager.buildRemoteReadSessionScript(cwd, afterTs)
      const sshArgs = [
        '-S', this.sshManager.getSocketPath(projectId),
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

    ipcMain.handle(
      'pty-spawn',
      async (
        event,
        id: string,
        shell: string,
        cwd: string,
        cols: number,
        rows: number,
        args?: string[],
        extraEnv?: Record<string, string>,
        projectId?: string,
        sshConfig?: SshConfig
      ): Promise<PtyAttachResult> => {
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window) {
          throw new Error('Unable to resolve window for PTY attach')
        }
        this.logDebug(`ptySpawnRequest windowId=${window.id} id=${id} shell=${shell} cwd=${cwd} cols=${cols} rows=${rows}`)
        return this.attachOrCreatePty(window.id, id, shell, cwd, cols, rows, args, extraEnv, projectId, sshConfig)
      }
    )

    ipcMain.on('pty-write', (event, id: string, data: string) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const runtime = this.ptyRuntimes.get(id)
      if (!window || !runtime || !runtime.attachedWindowIds.has(window.id)) return
      this.claimPtyControl(id, window.id)
      this.ptyManager.write(id, data)
    })

    ipcMain.on('pty-resize', (event, id: string, cols: number, rows: number) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const runtime = this.ptyRuntimes.get(id)
      if (!window || !runtime || !runtime.attachedWindowIds.has(window.id)) return
      if (!window.isFocused() && runtime.controllerWindowId !== window.id) {
        this.logDebug(`ptyResizeIgnored id=${id} windowId=${window.id} cols=${cols} rows=${rows}`)
        return
      }
      this.claimPtyControl(id, window.id)
      runtime.cols = cols
      runtime.rows = rows
      this.broadcastToAttachedWindows(id, 'pty-size-sync', id, cols, rows)
      this.ptyManager.resize(id, cols, rows)
    })

    ipcMain.on('pty-kill', (_event, id: string) => {
      this.killPty(id)
    })

    ipcMain.handle('workspace-list-branches', async (_event, projectDir: string) => {
      return this.workspaceManager.listBranches(projectDir)
    })

    ipcMain.handle('workspace-create', async (_event, projectDir: string, name: string, baseBranch: string) => {
      const result = await this.workspaceManager.create(projectDir, name, baseBranch)
      return { ...result, baseBranch }
    })

    ipcMain.handle(
      'workspace-delete',
      async (
        _event,
        projectDir: string,
        worktreePath: string,
        branchName: string,
        baseBranch: string,
        force?: boolean,
        keepBranch?: boolean
      ) => {
        return this.workspaceManager.delete({ projectDir, worktreePath, branchName, baseBranch, force, keepBranch })
      }
    )

    // File browser
    const validatePath = (projectCwd: string, relativePath: string): string => {
      const resolved = path.resolve(projectCwd, relativePath)
      if (!resolved.startsWith(path.resolve(projectCwd) + path.sep) && resolved !== path.resolve(projectCwd)) {
        throw new Error('Path traversal not allowed')
      }
      return resolved
    }

    ipcMain.handle('fb-read-directory', async (_event, projectCwd: string, relativeDirPath: string): Promise<DirectoryEntry[]> => {
      const fullPath = validatePath(projectCwd, relativeDirPath)
      const entries = await fsPromises.readdir(fullPath, { withFileTypes: true })
      return entries
        .filter(entry => !entry.name.startsWith('.'))
        .map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' as const : 'file' as const,
          relativePath: path.join(relativeDirPath, entry.name)
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    })

    ipcMain.handle('fb-read-file', async (_event, projectCwd: string, relativeFilePath: string): Promise<string> => {
      const fullPath = validatePath(projectCwd, relativeFilePath)
      return fsPromises.readFile(fullPath, 'utf-8')
    })

    ipcMain.handle('fb-write-file', async (_event, projectCwd: string, relativeFilePath: string, content: string): Promise<void> => {
      const fullPath = validatePath(projectCwd, relativeFilePath)
      await fsPromises.writeFile(fullPath, content, 'utf-8')
    })

    ipcMain.handle('fb-git-status', async (_event, projectCwd: string): Promise<GitStatusResult> => {
      const resolvedCwd = path.resolve(projectCwd)
      try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: resolvedCwd })
        const staged: GitStatusEntry[] = []
        const unstaged: GitStatusEntry[] = []
        const untracked: GitStatusEntry[] = []

        for (const line of stdout.split('\n')) {
          if (!line) continue
          const indexStatus = line[0]
          const workTreeStatus = line[1]
          const filePath = line.slice(3).trim()

          if (indexStatus === '?' && workTreeStatus === '?') {
            untracked.push({ relativePath: filePath, status: '?' })
          } else {
            if (indexStatus && indexStatus !== ' ' && indexStatus !== '?') {
              staged.push({ relativePath: filePath, status: indexStatus as GitFileStatus })
            }
            if (workTreeStatus && workTreeStatus !== ' ' && workTreeStatus !== '?') {
              unstaged.push({ relativePath: filePath, status: workTreeStatus as GitFileStatus })
            }
          }
        }

        return { staged, unstaged, untracked }
      } catch {
        return { staged: [], unstaged: [], untracked: [] }
      }
    })

    ipcMain.handle('fb-git-diff', async (_event, projectCwd: string, relativeFilePath: string): Promise<string> => {
      const resolvedCwd = path.resolve(projectCwd)
      try {
        const { stdout } = await execFileAsync('git', ['show', `HEAD:${relativeFilePath}`], { cwd: resolvedCwd })
        return stdout
      } catch {
        return ''
      }
    })
  }

  private async attachOrCreatePty(
    windowId: number,
    id: string,
    shell: string,
    cwd: string,
    cols: number,
    rows: number,
    args?: string[],
    extraEnv?: Record<string, string>,
    projectId?: string,
    sshConfig?: SshConfig
  ): Promise<PtyAttachResult> {
    let runtime = this.ptyRuntimes.get(id)
    if (!runtime) {
      this.logDebug(`ptyAttach create windowId=${windowId} id=${id}`)
      runtime = {
        attachedWindowIds: new Set<number>(),
        controllerWindowId: windowId,
        cols,
        rows,
        scrollback: this.scrollbackStorage.load(id) ?? '',
        exitCode: null
      }
      this.ptyRuntimes.set(id, runtime)
      runtime.attachedWindowIds.add(windowId)
      this.spawnPty(id, shell, cwd, cols, rows, args, extraEnv, projectId, sshConfig)
    } else {
      this.logDebug(`ptyAttach reuse windowId=${windowId} id=${id} scrollback=${runtime.scrollback.length} exit=${runtime.exitCode}`)
      runtime.attachedWindowIds.add(windowId)
    }
    return {
      cols: runtime.cols,
      rows: runtime.rows,
      scrollback: runtime.scrollback,
      exitCode: runtime.exitCode
    }
  }

  private spawnPty(
    id: string,
    shell: string,
    cwd: string,
    cols: number,
    rows: number,
    args?: string[],
    extraEnv?: Record<string, string>,
    projectId?: string,
    sshConfig?: SshConfig
  ): void {
    this.logDebug(`ptySpawn start id=${id} shell=${shell} cwd=${cwd}`)
    if (sshConfig && projectId) {
      if (this.sshManager.getStatus(projectId) !== 'connected') {
        throw new Error('SSH connection not established')
      }

      const isClaudeRemote = shell === 'claude' && extraEnv?.DEVTOOL_TAB_ID
      let hookInjectPrefix = ''
      if (isClaudeRemote) {
        const remotePort = this.sshManager.getRemotePort(projectId)
        if (remotePort) {
          this.hookInjector.remoteInject(projectId)
          hookInjectPrefix = this.hookInjector.buildRemoteInjectScript(sshConfig.remoteDir, remotePort) + ' && '
        }
      }

      const sshArgs = this.sshManager.buildSpawnArgs(projectId, sshConfig, shell, args, extraEnv, hookInjectPrefix)
      this.ptyManager.spawn(id, 'ssh', os.tmpdir(), cols, rows, sshArgs, undefined, {
        onData: (data) => {
          const runtime = this.ptyRuntimes.get(id)
          if (!runtime) return
          runtime.scrollback = trimScrollback(runtime.scrollback + data)
          this.logDebug(`ptyData id=${id} len=${data.length} total=${runtime.scrollback.length}`)
          this.broadcastToAttachedWindows(id, 'pty-data', id, data)
        },
        onExit: (exitCode) => {
          const runtime = this.ptyRuntimes.get(id)
          if (!runtime) return
          runtime.exitCode = exitCode
          this.logDebug(`ptyExit id=${id} exitCode=${exitCode}`)
          this.broadcastToAttachedWindows(id, 'pty-exit', id, exitCode)
        }
      })
    } else {
      const isClaudeLocal = shell === 'claude' && extraEnv?.DEVTOOL_TAB_ID
      if (isClaudeLocal) {
        this.hookInjector.inject(cwd)
      }
      this.ptyManager.spawn(id, shell, cwd, cols, rows, args, extraEnv, {
        onData: (data) => {
          const runtime = this.ptyRuntimes.get(id)
          if (!runtime) return
          runtime.scrollback = trimScrollback(runtime.scrollback + data)
          this.logDebug(`ptyData id=${id} len=${data.length} total=${runtime.scrollback.length}`)
          this.broadcastToAttachedWindows(id, 'pty-data', id, data)
        },
        onExit: (exitCode) => {
          const runtime = this.ptyRuntimes.get(id)
          if (!runtime) return
          runtime.exitCode = exitCode
          this.logDebug(`ptyExit id=${id} exitCode=${exitCode}`)
          this.broadcastToAttachedWindows(id, 'pty-exit', id, exitCode)
        }
      })
    }
  }

  private killPty(id: string): void {
    this.logDebug(`ptyKill id=${id}`)
    this.ptyManager.kill(id)
    this.ptyRuntimes.delete(id)
  }

  private claimPtyControl(tabId: string, windowId: number): void {
    const runtime = this.ptyRuntimes.get(tabId)
    if (!runtime) return
    if (runtime.controllerWindowId !== windowId) {
      runtime.controllerWindowId = windowId
      this.logDebug(`ptyController id=${tabId} windowId=${windowId}`)
    }
  }

  private updateWindowGeometry(windowId: number): void {
    const window = this.windows.get(windowId)
    const current = this.windowStates.get(windowId)
    if (!window || window.isDestroyed() || !current) return

    this.windowStates.set(windowId, {
      geometry: getWindowGeometry(window),
      viewState: cloneWindowViewState(current.viewState)
    })
  }

  private persistWindowSession(): void {
    this.storage.saveWindowSession({
      windows: Array.from(this.windowStates.values()).map((state) => clonePersistedWindowState(state))
    })
  }

  private logDebug(message: string): void {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true })
      }
      fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`)
    } catch {
      // Best-effort logging only.
    }
  }

  private broadcastToAllWindows(channel: string, ...args: unknown[]): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, ...args)
      }
    }
  }

  private getProjectTunnel(projectId: string): TunnelConfig | undefined {
    return this.projectsData.projects.find((project) => project.id === projectId)?.tunnel
  }

  private broadcastToAttachedWindows(tabId: string, channel: string, ...args: unknown[]): void {
    const runtime = this.ptyRuntimes.get(tabId)
    if (!runtime) return
    for (const windowId of runtime.attachedWindowIds) {
      const window = this.windows.get(windowId)
      if (window && !window.isDestroyed()) {
        window.webContents.send(channel, ...args)
      }
    }
  }
}

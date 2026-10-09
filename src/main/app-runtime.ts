import { app, BrowserWindow, ipcMain, nativeTheme, powerMonitor, shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HostServices } from './host/host-services'
import { ServerHub } from './servers/server-hub'
import { DesktopRouting } from './servers/desktop-routing'
import { registerServerHandlers } from './ipc/servers'
import { normalizeMobileConfig } from '../shared/mobile'
import type { HostEnv } from './host/host-env'
import { createDesktopHostEnv, logDebug } from './desktop-host-env'
import { WindowClientHub, windowClientId } from './window-client-hub'
import { createIpcRegistrar } from './ipc/registrar'
import { createAppUrlMatcher } from './ipc/sender'
import { registerWindowHandlers, type WindowIpcContext } from './ipc/window'
import { registerSocksProxyHandlers, routeBrowserDirectQuietly, routeBrowserThroughSocks } from './ipc/socks-proxy'
import { registerUpdateHandlers } from './ipc/updates'
import { createUpdates, type Updates } from './updates'
import { probeRedirect } from './release-redirect'
import { decideUpdateMode } from '../shared/updates'
import type {
  PersistedWindowState,
  WindowGeometry,
  WindowViewState
} from '../shared/types'
import {
  buildWindowViewState,
  clonePersistedWindowState,
  cloneWindowGeometry,
  cloneWindowViewState
} from '../shared/types'

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

/**
 * The desktop shell: windows and their persisted state, native dialogs, the
 * theme, updates and the browser tabs' SOCKS routing, around a local
 * {@link HostServices} that does everything else.
 */
export class AppRuntime {
  /** The windows, as the host's clients. */
  private readonly clients = new WindowClientHub<BrowserWindow>()
  private readonly host: HostServices
  private readonly env: HostEnv
  /** The DevTool servers this desktop paired with, on the relay socket the phones use. */
  private servers!: ServerHub
  /** Server projects and the router that sends a server project's calls to its server. */
  private readonly routing: DesktopRouting
  private readonly windowStates = new Map<number, PersistedWindowState>()
  private updates!: Updates
  private started = false
  private quitting = false
  private socksProxyEnabled = new Map<string, boolean>()
  private socksProxyStarting = new Map<string, Promise<number>>()
  private startupWindowStates: PersistedWindowState[]

  constructor(private readonly createWindow: (viewState?: WindowViewState | null, geometry?: WindowGeometry | null) => BrowserWindow) {
    this.env = createDesktopHostEnv()
    this.routing = new DesktopRouting({ configDir: this.env.configDir, windows: this.clients, log: (message) => this.logDebug(message) })
    this.host = new HostServices({
      env: this.env,
      clients: this.clients,
      onTaskArchived: (taskId) => this.forgetTaskInWindowStates(taskId),
      projects: { foreign: () => this.routing.foreignProjects() }
    })
    this.routing.attachHost(this.host)
    this.startupWindowStates = this.host.storage.loadWindowSession(
      this.allProjectsData(),
      this.host.getConfig().defaultSidebarTab
    ).windows
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.host.start()
    this.servers = this.createServerHub()
    this.updates = this.createUpdates()
    this.registerEventForwarders()
    this.registerIpcHandlers()
    this.updates.start()
  }

  private createServerHub(): ServerHub {
    const mobile = () => normalizeMobileConfig(this.host.getConfig().mobile)
    const servers = new ServerHub({
      configDir: this.env.configDir,
      relay: this.host.relay,
      identity: this.host.identity,
      relayUrl: () => mobile().relayUrl,
      // Commit and bundle hash arrive with the bundled server (step 5).
      build: { version: app.getVersion(), commit: '', builtAt: '', bundleSha: '' },
      desktopName: () => mobile().desktopName?.trim() || os.hostname().replace(/\.local$/, ''),
      log: (message) => this.logDebug(message)
    })
    servers.onStateChange((state) => this.clients.broadcast('servers-state-changed', state))
    this.routing.attachHub(servers)
    this.host.onConfigChanged(() => servers.relayUrlChanged())
    servers.start()
    this.devPairServer(servers)
    return servers
  }

  /**
   * Dev runs only (protocol/SERVER.md §7): `DEVTOOL_DEV_SERVER_PAIR=1` logs this
   * desktop's keys for a server's `--dev-pair`; set to the code that server prints,
   * it pairs with that server.
   */
  private devPairServer(servers: ServerHub): void {
    const value = process.env.DEVTOOL_DEV_SERVER_PAIR?.trim()
    if (!value || app.isPackaged) return
    try {
      this.logDebug(`servers devKeys=${servers.devKeys()}`)
      if (value.startsWith('devtool-dev-pair:')) servers.devPair(value)
    } catch (err) {
      this.logDebug(`servers devPair error=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The updater, for the app menu's "Check for Updates…". */
  getUpdates(): Updates {
    return this.updates
  }

  private createUpdates(): Updates {
    let signed = false
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { devtoolSigned?: unknown }
      signed = pkg.devtoolSigned === true
    } catch {
      // Unreadable package.json: treat as unsigned.
    }
    const mode = decideUpdateMode({
      isPackaged: app.isPackaged,
      platform: process.platform,
      hasUpdateConfig: app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')),
      signed
    })
    return createUpdates({
      mode,
      appVersion: app.getVersion(),
      autoCheck: () => this.host.getConfig().autoCheckUpdates !== false,
      broadcast: (status) => this.clients.broadcast('updates-status', status),
      openExternal: (url) => { void shell.openExternal(url).catch(() => {}) },
      probeRedirect: (url) => probeRedirect(url),
      now: () => Date.now(),
      log: (message) => this.logDebug(message),
      loadAutoUpdater: async () => {
        const mod = await import('electron-updater')
        // `autoUpdater` is a lazy getter on a CJS module, which import() only
        // exposes on `default` (the named binding comes back undefined).
        return mod.autoUpdater ?? (mod as unknown as { default: typeof mod }).default.autoUpdater
      }
    })
  }

  registerWindow(window: BrowserWindow, initialViewState?: WindowViewState | null): void {
    const clientId = this.clients.add(window)
    this.windowStates.set(window.id, {
      geometry: getWindowGeometry(window),
      viewState: initialViewState
        ? cloneWindowViewState(initialViewState)
        : buildWindowViewState(this.allProjectsData().projects, this.host.getConfig())
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
      this.clients.remove(clientId)
      if (!this.quitting) {
        this.windowStates.delete(window.id)
        this.persistWindowSession()
      }
      this.host.detachClient(clientId)
      this.servers?.detachClient(clientId)
    })
  }

  getStartupWindowStates(): PersistedWindowState[] {
    return this.startupWindowStates.map((state) => clonePersistedWindowState(state))
  }

  prepareForQuit(): void {
    this.quitting = true
  }

  /**
   * Main's own copy of each window's selection is what gets persisted on quit,
   * so a task main archived (a phone's close, a landing) has to leave it too.
   */
  private forgetTaskInWindowStates(taskId: string): void {
    for (const [windowId, state] of this.windowStates.entries()) {
      const taskStates = { ...state.viewState.taskStates }
      const hadTaskState = taskId in taskStates
      const wasSelected = state.viewState.selectedTaskId === taskId
      if (!hadTaskState && !wasSelected) continue
      delete taskStates[taskId]
      this.windowStates.set(windowId, {
        geometry: cloneWindowGeometry(state.geometry),
        viewState: {
          ...cloneWindowViewState(state.viewState),
          selectedTaskId: wasSelected ? null : state.viewState.selectedTaskId,
          taskStates
        }
      })
    }
    this.persistWindowSession()
  }

  async shutdown(): Promise<void> {
    this.persistWindowSession()
    this.updates?.close()
    this.servers?.stop()
    await this.host.shutdown()
  }

  private registerEventForwarders(): void {
    const sshManager = this.host.sshManager

    // After the host's own listener, which tells the windows the new status.
    sshManager.on('status-changed', async (projectId: string, status: string) => {
      if (status === 'disconnected' && this.socksProxyEnabled.get(projectId)) {
        await routeBrowserDirectQuietly(projectId)
        this.clients.broadcast('socks-proxy-status-changed', projectId, false)
      }

      if (status === 'connected') {
        await this.restoreSocksProxy(projectId)
      }
    })

    // A master that slept through its connection's death still answers the
    // health check's `-O check`; probe end to end so it is replaced right away.
    powerMonitor.on('resume', () => {
      this.logDebug('powerResume verifying ssh connections')
      sshManager.verifyAll()
    })

    sshManager.on('socks-proxy-status-changed', async (projectId: string, enabled: boolean) => {
      if (!enabled) {
        await routeBrowserDirectQuietly(projectId)
        this.clients.broadcast('socks-proxy-status-changed', projectId, false)

        const config = sshManager.getConfig(projectId)
        if (this.socksProxyEnabled.get(projectId) && config && sshManager.getStatus(projectId) === 'connected') {
          try {
            const port = await sshManager.startSocksProxy(projectId, config)
            await routeBrowserThroughSocks(projectId, port)
            this.clients.broadcast('socks-proxy-status-changed', projectId, true, port)
          } catch {
            // Auto-restart failed — stay in direct mode
          }
        }
      }
    })

    nativeTheme.on('updated', () => {
      this.clients.broadcast('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    })
  }

  /** Restore the SOCKS proxy the user enabled for a project. Runs on every
   *  transition into 'connected' — manual connect and auto-reconnect alike — so
   *  a recovered connection isn't left without the proxy that was configured. */
  private async restoreSocksProxy(projectId: string): Promise<void> {
    if (!this.socksProxyEnabled.get(projectId)) return
    const sshManager = this.host.sshManager
    if (sshManager.getSocksProxy(projectId)) return
    const sshConfig = sshManager.getConfig(projectId)
    if (!sshConfig) return
    try {
      const port = await sshManager.startSocksProxy(projectId, sshConfig)
      await routeBrowserThroughSocks(projectId, port)
      this.clients.broadcast('socks-proxy-status-changed', projectId, true, port)
    } catch {
      // Keep SSH connected even when restoring the SOCKS proxy fails.
    }
  }

  private registerIpcHandlers(): void {
    const log = (message: string) => this.logDebug(message)
    const isAppUrl = createAppUrlMatcher(process.env.ELECTRON_RENDERER_URL)
    const ipc = createIpcRegistrar<WindowIpcContext>({
      ipcMain,
      senderPolicy: {
        isAppWebContents: (webContentsId) => this.clients.forWebContents(webContentsId) !== null,
        isAppUrl
      },
      context: (event) => {
        const window = this.clients.forWebContents(event.sender.id)
        if (!window) throw new Error('sender is not a DevTool window')
        return { clientId: windowClientId(window.id), isFocused: () => window.isFocused(), window }
      },
      log
    })
    const resolveRoot = (dir: string) => this.host.resolveAllowedDirectory(dir)

    // Every host channel goes through the router: a server project's calls run on its server.
    this.host.registerIpcHandlers(this.routing.wrap(ipc))

    registerWindowHandlers(ipc, {
      loadViewState: (windowId) => {
        const state = this.windowStates.get(windowId) ?? null
        return state
          ? cloneWindowViewState(state.viewState)
          : buildWindowViewState(this.allProjectsData().projects, this.host.getConfig())
      },
      saveViewState: (window, viewState) => {
        const current = this.windowStates.get(window.id)
        this.windowStates.set(window.id, {
          geometry: current ? cloneWindowGeometry(current.geometry) : getWindowGeometry(window),
          viewState: cloneWindowViewState(viewState)
        })
        this.persistWindowSession()
      },
      openWindow: (viewState) => {
        this.logDebug(`openWindow seeded=${viewState ? 'yes' : 'no'}`)
        this.createWindow(viewState, null)
      },
      getConfig: () => this.host.getConfig(),
      assertAllowedDirectory: resolveRoot,
      isServerProject: (projectId) => this.routing.isServerProject(projectId)
    })

    registerSocksProxyHandlers(ipc, {
      sshManager: () => this.host.sshManager,
      socksProxyEnabled: this.socksProxyEnabled,
      socksProxyStarting: this.socksProxyStarting,
      broadcast: (channel, ...args) => this.clients.broadcast(channel, ...args),
      log
    })

    registerUpdateHandlers(ipc, { updates: () => this.updates })
    registerServerHandlers(ipc, { servers: () => this.servers })
  }

  /** This desktop's projects plus every server's, as the windows list them. */
  private allProjectsData() {
    return this.routing.mergedProjects(this.host.getProjectsData())
  }

  private updateWindowGeometry(windowId: number): void {
    const window = this.clients.get(windowClientId(windowId))
    const current = this.windowStates.get(windowId)
    if (!window || window.isDestroyed() || !current) return

    this.windowStates.set(windowId, {
      geometry: getWindowGeometry(window),
      viewState: cloneWindowViewState(current.viewState)
    })
  }

  private persistWindowSession(): void {
    this.host.storage.saveWindowSession({
      windows: Array.from(this.windowStates.values()).map((state) => clonePersistedWindowState(state))
    })
  }

  private logDebug(message: string): void {
    logDebug(message)
  }
}

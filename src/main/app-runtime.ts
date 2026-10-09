import { app, BrowserWindow, ipcMain, nativeTheme, powerMonitor, shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HostServices } from './host/host-services'
import { ServerHub } from './servers/server-hub'
import { desktopBundle, desktopBundleDir } from './servers/desktop-bundle'
import { DEFAULT_INSTALL_URL } from '../shared/servers'
import { DesktopRouting } from './servers/desktop-routing'
import { registerProjectMoveHandlers, registerServerHandlers, registerSshInstallHandlers, type ProjectMoveControl, type SshInstallControl } from './ipc/servers'
import { SshInstallSessions } from './servers/ssh-install'
import { ProjectMover } from './servers/project-move'
import { probeSshHost } from './servers/ssh-probe'
import { MAIN_CLIENT_ID } from './servers/server-projects'
import { sshInstallTargetOf } from '../shared/project-move'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as nodePty from 'node-pty'
import { getShellEnv } from './shell-env'
import { sshExecutable } from './resolve-agent-command'
import { normalizeMobileConfig } from '../shared/mobile'
import type { HostEnv } from './host/host-env'
import { createDesktopHostEnv, logDebug } from './desktop-host-env'
import { WindowClientHub, windowClientId } from './window-client-hub'
import { createIpcRegistrar } from './ipc/registrar'
import { createAppUrlMatcher } from './ipc/sender'
import { registerWindowHandlers, type WindowIpcContext } from './ipc/window'
import { answerServerProxyLogins, registerServerBrowserHandlers, registerSocksProxyHandlers, routeBrowserDirectQuietly, routeBrowserThroughServerProxy, routeBrowserThroughSocks } from './ipc/socks-proxy'
import { registerServerIdeHandlers } from './ipc/server-ide'
import { ServerBrowserProxies } from './servers/server-browser-proxy'
import { ServerIde } from './servers/server-ide'
import { LOCAL_HOST } from './servers/host-router'
import { TCP_STREAM_KIND, connectTcpStream, type TcpTarget } from './host/link/tcp-stream'
import type { LinkStream } from './host/link/stream'
import { openRemoteFolderInEditor } from './external-ide'
import { registerUpdateHandlers } from './ipc/updates'
import { createUpdates, type Updates } from './updates'
import { probeRedirect } from './release-redirect'
import { decideUpdateMode } from '../shared/updates'
import type {
  PersistedWindowState,
  Project,
  SshConfig,
  WindowGeometry,
  WindowViewState
} from '../shared/types'
import {
  buildWindowViewState,
  clonePersistedWindowState,
  cloneWindowGeometry,
  cloneWindowViewState
} from '../shared/types'

const execFileAsync = promisify(execFile)

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
  /** Add server › Install over SSH: the ssh ptys, one per dialog that started one. */
  private sshInstalls!: SshInstallSessions
  /** Move to a DevTool server: an SSH project becomes a server's. */
  private mover!: ProjectMover
  /** Server projects and the router that sends a server project's calls to its server. */
  private readonly routing: DesktopRouting
  private readonly windowStates = new Map<number, PersistedWindowState>()
  private updates!: Updates
  private started = false
  private quitting = false
  private socksProxyEnabled = new Map<string, boolean>()
  private socksProxyStarting = new Map<string, Promise<number>>()
  /** Browser tabs of server projects: an authenticated HTTP proxy per server (plan step 9). */
  private serverBrowser: ServerBrowserProxies | null = null
  /** Open in IDE for server projects: DevTool's ssh config and a socket per server (plan step 9). */
  private serverIde: ServerIde | null = null
  private startupWindowStates: PersistedWindowState[]

  constructor(private readonly createWindow: (viewState?: WindowViewState | null, geometry?: WindowGeometry | null) => BrowserWindow) {
    this.env = createDesktopHostEnv()
    this.routing = new DesktopRouting({ configDir: this.env.configDir, windows: this.clients, log: (message) => this.logDebug(message), images: this.env.images })
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
    this.sshInstalls = this.createSshInstalls()
    this.mover = this.createProjectMover()
    this.updates = this.createUpdates()
    this.createServerTools()
    this.registerEventForwarders()
    this.registerIpcHandlers()
    this.updates.start()
  }

  private installUrl(): string {
    return process.env.DEVTOOL_INSTALL_URL?.trim() || DEFAULT_INSTALL_URL
  }

  private createSshInstalls(): SshInstallSessions {
    return new SshInstallSessions({
      spawn: (file, args, options) => nodePty.spawn(file, args, options),
      send: (clientId, channel, ...args) => this.clients.send(clientId, channel, ...args),
      token: () => {
        // The invite on screen, unless it is about to lapse or a server already used it.
        const invite = this.servers.getState().invite
        if (invite?.status === 'waiting' && invite.expiresAt - Date.now() > 60_000) return invite.token
        return this.servers.createInvite().token
      },
      installUrl: () => this.installUrl(),
      ssh: () => sshExecutable(),
      env: () => getShellEnv(),
      log: (message) => this.logDebug(message)
    })
  }

  private createProjectMover(): ProjectMover {
    return new ProjectMover({
      local: {
        peek: () => this.host.getProjectsData(),
        commit: (data) => { this.host.commitProjects(data) },
        archive: (projectId) => this.host.archiveOf(projectId),
        liveTabs: (tabIds) => this.host.liveTabs(tabIds),
        endTabs: (project) => this.host.endProjectTabs(project)
      },
      servers: this.routing.projects,
      call: (serverId, ch, args) => this.servers.call(serverId, MAIN_CLIENT_ID, ch, args),
      unpin: (tabId) => this.routing.index.unpin(tabId),
      tabsMoved: (event) => this.clients.broadcast('tabs-moved', event),
      closeSsh: (projectId, ssh) => this.closeSshProject(projectId, ssh),
      log: (message) => this.logDebug(message)
    })
  }

  /** One of this desktop's SSH projects, or a readable refusal. */
  private sshProject(projectId: string): Project & { ssh: SshConfig } {
    const project = this.host.getProjectsData().projects.find(p => p.id === projectId)
    if (!project?.ssh || project.host) throw new Error('That is not an SSH project on this computer.')
    return project as Project & { ssh: SshConfig }
  }

  /** The SSH project's ControlMaster socket while it is connected. */
  private sshControlPath(projectId: string): string | null {
    const ssh = this.host.sshManager
    return ssh.getStatus(projectId) === 'connected' ? ssh.getSocketPath(projectId) : null
  }

  /** As `ssh-disconnect` does: browser tabs back on a direct connection first, then the master, tunnel and SOCKS go. */
  private async closeSshProject(projectId: string, ssh: SshConfig): Promise<void> {
    if (this.socksProxyEnabled.get(projectId)) {
      await routeBrowserDirectQuietly(projectId)
      this.clients.broadcast('socks-proxy-status-changed', projectId, false)
    }
    this.socksProxyEnabled.delete(projectId)
    this.socksProxyStarting.delete(projectId)
    await this.host.sshManager.disconnect(projectId, ssh)
  }

  private projectMoveControl(): ProjectMoveControl {
    return {
      probe: async (projectId) => {
        const project = this.sshProject(projectId)
        return probeSshHost(project.ssh, {
          controlPath: this.sshControlPath(projectId),
          sshCommand: sshExecutable(),
          run: (file, args, options) => execFileAsync(file, args, { ...options, env: getShellEnv() })
        })
      },
      move: (projectId, serverId) => this.mover.move(projectId, serverId)
    }
  }

  private sshInstallControl(): SshInstallControl {
    const sessions = this.sshInstalls
    return {
      start: (clientId, target, size, options) => {
        if (!options.projectId) return sessions.start(clientId, target, size)
        // An SSH project's machine: its own target, and its ControlMaster when up.
        const project = this.sshProject(options.projectId)
        return sessions.start(clientId, sshInstallTargetOf(project.ssh), size, { controlPath: this.sshControlPath(project.id) ?? undefined })
      },
      write: (clientId, sessionId, data) => sessions.write(clientId, sessionId, data),
      resize: (clientId, sessionId, cols, rows) => sessions.resize(clientId, sessionId, cols, rows),
      stop: (clientId, sessionId) => sessions.stop(clientId, sessionId)
    }
  }

  private createServerHub(): ServerHub {
    const mobile = () => normalizeMobileConfig(this.host.getConfig().mobile)
    const servers = new ServerHub({
      configDir: this.env.configDir,
      relay: this.host.relay,
      identity: this.host.identity,
      relayUrl: () => mobile().relayUrl,
      build: { version: app.getVersion(), commit: '', builtAt: '', bundleSha: '' },
      bundle: desktopBundle(desktopBundleDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })),
      installUrl: () => this.installUrl(),
      desktopName: () => mobile().desktopName?.trim() || os.hostname().replace(/\.local$/, ''),
      log: (message) => this.logDebug(message)
    })
    servers.onStateChange((state) => this.clients.broadcast('servers-state-changed', state))
    this.routing.attachHub(servers)
    this.host.onConfigChanged(() => servers.relayUrlChanged())
    servers.start()
    return servers
  }

  /** A connected `tcp` stream the server dials (protocol/SERVER.md §6.3). */
  private openTcp(serverId: string, target: TcpTarget): Promise<LinkStream> {
    return connectTcpStream(() => this.servers.openStream(serverId, TCP_STREAM_KIND, target))
  }

  /** The DevTool server a project lives on; null for this desktop's own. */
  private serverOf(projectId: string): string | null {
    const host = this.routing.index.hostOfProject(projectId)
    return host && host !== LOCAL_HOST ? host : null
  }

  /** Browser tabs on server ports and Open in IDE over SSH, both through `tcp` streams. */
  private createServerTools(): void {
    const log = (message: string) => this.logDebug(message)
    const serverBrowser = new ServerBrowserProxies({
      openTcp: (serverId, target) => this.openTcp(serverId, target),
      route: (projectId, port) => routeBrowserThroughServerProxy(projectId, port),
      log
    })
    const serverIde = new ServerIde({
      configDir: this.env.configDir,
      // Tests and live checks point this at a scratch file, never the user's own.
      userSshConfig: process.env.DEVTOOL_USER_SSH_CONFIG?.trim() || path.join(os.homedir(), '.ssh', 'config'),
      home: os.homedir(),
      platform: process.platform,
      servers: () => this.servers.getState(),
      call: (serverId, ch, args) => this.servers.call(serverId, MAIN_CLIENT_ID, ch, args),
      openTcp: (serverId, target) => this.openTcp(serverId, target),
      desktopName: () => normalizeMobileConfig(this.host.getConfig().mobile).desktopName?.trim() || os.hostname().replace(/\.local$/, ''),
      execPath: process.execPath,
      launch: (editor, alias, folder) => openRemoteFolderInEditor(editor, alias, folder),
      log
    })
    this.serverBrowser = serverBrowser
    this.serverIde = serverIde
    answerServerProxyLogins(() => this.serverBrowser)
    let paired = new Set(this.servers.getState().servers.map((s) => s.id))
    this.servers.onStateChange((state) => {
      const now = new Set(state.servers.map((s) => s.id))
      for (const serverId of paired) if (!now.has(serverId)) void serverBrowser.forget(serverId)
      paired = now
      serverIde.serversChanged(state)
    })
    this.servers.onBeforeRemove((serverId) => serverIde.revoke(serverId))
    void serverIde.start().catch((err: unknown) => log(`serverIde start error=${err instanceof Error ? err.message : String(err)}`))
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
      this.serverBrowser?.releaseClient(clientId)
      this.host.detachClient(clientId)
      this.servers?.detachClient(clientId)
      this.sshInstalls?.detachClient(clientId)
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
    this.sshInstalls?.stopAll()
    this.servers?.stop()
    await Promise.all([this.serverBrowser?.stop(), this.serverIde?.stop()]).catch(() => {})
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
      isServerProject: (projectId) => this.routing.isServerProject(projectId),
      openOnServer: async (editor, projectId, folder) => {
        const serverId = this.serverOf(projectId)
        if (!serverId || !this.serverIde) throw new Error('This project is not on a DevTool server')
        await this.serverIde.open(editor, serverId, folder)
      }
    })

    registerSocksProxyHandlers(ipc, {
      sshManager: () => this.host.sshManager,
      socksProxyEnabled: this.socksProxyEnabled,
      socksProxyStarting: this.socksProxyStarting,
      broadcast: (channel, ...args) => this.clients.broadcast(channel, ...args),
      log
    })
    registerServerBrowserHandlers(ipc, {
      proxies: () => this.serverBrowser!,
      serverOf: (projectId) => this.serverOf(projectId)
    })
    registerServerIdeHandlers(ipc, {
      state: (serverId) => this.serverIde!.state(serverId),
      setup: (serverId, consent) => this.serverIde!.setup(serverId, consent),
      serverOf: (projectId) => this.serverOf(projectId)
    })

    registerUpdateHandlers(ipc, { updates: () => this.updates })
    registerServerHandlers(ipc, { servers: () => this.servers })
    registerSshInstallHandlers(ipc, { sshInstalls: () => this.sshInstallControl() })
    registerProjectMoveHandlers(ipc, { moves: () => this.projectMoveControl() })
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

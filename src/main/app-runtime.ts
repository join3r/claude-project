import { app, BrowserWindow, ipcMain, nativeTheme, powerSaveBlocker, safeStorage, shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { Storage } from './storage'
import { CONFIG_DIR } from './config-dir'
import { ScrollbackStorage } from './scrollback-storage'
import { PtyManager } from './pty-manager'
import { PtySessions } from './pty-sessions'
import { HookServer } from './hook-server'
import { HookInjector, hookEndpointFor } from './hook-injector'
import { ClaudeChatManager } from './claude-chat/chat-manager'
import { SshConnectionManager } from './ssh-connection-manager'
import { CodexSessionManager } from './codex-session-manager'
import { RemoteWorkspaceManager } from './remote-workspace-manager'
import { WorkspaceManager } from './workspace-manager'
import { NotesStorage } from './notes-storage'
import { RevisionStore } from './revision-store'
import { TabActivityRegistry } from './tab-activity-registry'
import { SleepBlocker } from './sleep-blocker'
import type { ActivityUpdate } from '../shared/agent-activity'
import { runIdleCleanupSweep, type IdleCleanupEnvironment } from './idle-cleanup-sweep'
import { tearDownTaskTabs } from './task-teardown'
import { PaletteFrecencyStorage } from './palette-frecency-storage'
import { agentCommandOverride, resolveAgentCommand } from './resolve-agent-command'
import { findGitBashExe, getShellEnv, setPortableNodeDir } from './shell-env'
import { createIpcRegistrar } from './ipc/registrar'
import { createAppUrlMatcher } from './ipc/sender'
import { allowedLocalRoots, resolveAllowedDirectory } from './ipc/path-allowlist'
import { registerAppStateHandlers } from './ipc/app-state'
import { registerWindowHandlers } from './ipc/window'
import { registerSshHandlers, routeBrowserDirectQuietly, routeBrowserThroughSocks } from './ipc/ssh'
import { registerAgentHandlers } from './ipc/agents'
import { registerTerminalHandlers } from './ipc/terminals'
import { registerWorkspaceHandlers } from './ipc/workspaces'
import { registerFileBrowserHandlers } from './ipc/file-browser'
import { registerGitHandlers } from './ipc/git'
import { registerNotebookHandlers } from './ipc/notebooks'
import { isRemoteProject, isShellCommandProject } from '../shared/types'
import {
  NOTEBOOK_ERROR_REMOTE,
  NOTEBOOK_ERROR_SHELL_PROJECT,
  resolveNotebookKernelCondaEnv,
  type NotebookKernelCondaOverride
} from '../shared/notebook'
import { notebookAllowedCwdRoots, resolveNotebookKernelCwd } from './notebook-cwd'
import { listCondaEnvs, listCondaEnvsForNotebookKernel, resolveProjectCondaEnv } from './conda-env'
import { NotebookKernelManager } from './notebook-kernel'
import { safeWebContentsSend } from './safe-ipc-send'
import type { CondaEnvInfo } from '../shared/conda'
import { registerMobileHandlers } from './ipc/mobile'
import { registerUpdateHandlers } from './ipc/updates'
import { createUpdates, type Updates } from './updates'
import { probeRedirect } from './release-redirect'
import { decideUpdateMode } from '../shared/updates'
import { MobileService } from './mobile/mobile-service'
import { PairingsStore } from './mobile/pairings-store'
import { IdentityStore } from './mobile/identity'
import { createInvite } from './mobile/invite'
import { RelayClient } from './mobile/relay-client'
import { createNoiseChannelFactory } from './mobile/channel'
import { ChatBridge } from './mobile/chat-bridge'
import { PushEmitter } from './mobile/push-emitter'
import { addChatTab } from './mobile/new-chat'
import { AppErrorCode, CHAT_NEW_FEATURE } from '../../protocol/ts/index.ts'
import { normalizeMobileConfig } from '../shared/mobile'
import type {
  AppConfig,
  CleanupActivity,
  PersistedWindowState,
  Project,
  ProjectsData,
  SshConfig,
  Task,
  TunnelConfig,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResult,
  WindowGeometry,
  WindowViewState,
  NotesRecord
} from '../shared/types'
import {
  buildWindowViewState,
  clonePersistedWindowState,
  cloneWindowGeometry,
  cloneWindowViewState
} from '../shared/types'

const execFileAsync = promisify(execFile)

/**
 * Let the windows come up before the first sweep: what is on screen, which
 * buffers are unsaved and which PTYs are alive are all safeguards main only
 * learns once the renderers have reported in.
 */
const IDLE_CLEANUP_STARTUP_DELAY_MS = 15_000
const IDLE_CLEANUP_INTERVAL_MS = 60 * 60_000
const DEBUG_LOG_PATH = path.join(CONFIG_DIR, 'debug.log')

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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
  private readonly notesStorage = new NotesStorage(CONFIG_DIR)
  private readonly paletteFrecencyStorage = new PaletteFrecencyStorage(CONFIG_DIR)
  private readonly ptyManager = new PtyManager()
  /** Native notebook tabs' Jupyter kernels, one per tab. */
  private readonly notebookKernels = new NotebookKernelManager()
  /** tabId -> token of a kernel start still awaiting its conda lookup. */
  private readonly pendingNotebookStarts = new Map<string, number>()
  private notebookStartCounter = 0
  private readonly hookServer = new HookServer((message) => this.logDebug(message))
  private readonly codexSessionManager = new CodexSessionManager()
  private readonly workspaceManager = new WorkspaceManager()
  private readonly remoteWorkspaceManager = new RemoteWorkspaceManager()
  private readonly windows = new Map<number, BrowserWindow>()
  private readonly windowStates = new Map<number, PersistedWindowState>()
  private readonly ptySessions: PtySessions
  /** Main's authoritative view of what every tab's agent is doing. */
  private readonly activityRegistry = new TabActivityRegistry()
  private readonly sleepBlocker: SleepBlocker
  /** Tabs with an unsaved editor buffer, per window — a task holding one is not swept. */
  private readonly dirtyTabsByWindow = new Map<number, Set<string>>()
  /** Which window last reported each hook-less tab's status (`report-tab-status`). */
  private readonly statusReporters = new Map<string, number>()
  private hookInjector!: HookInjector
  private sshManager!: SshConnectionManager
  /** Claude chat tabs' processes — the Agent SDK counterpart of `ptySessions`. */
  private chatManager!: ClaudeChatManager
  /** Phones: relay connection, pairing and the inbox they see. Dormant while Mobile is off. */
  private mobileService!: MobileService
  private updates!: Updates
  private started = false
  private quitting = false
  private socksProxyEnabled = new Map<string, boolean>()
  private socksProxyStarting = new Map<string, Promise<number>>()
  private readonly projectsStore: RevisionStore<ProjectsData>
  private readonly notesStore: RevisionStore<NotesRecord>
  private config: AppConfig
  private startupWindowStates: PersistedWindowState[]
  private idleCleanupTimer: NodeJS.Timeout | null = null
  private idleCleanupScheduled = false
  private idleCleanupRunning = false

  constructor(private readonly createWindow: (viewState?: WindowViewState | null, geometry?: WindowGeometry | null) => BrowserWindow) {
    this.storage.backupProjectsOnStartup()
    this.projectsStore = new RevisionStore<ProjectsData>({
      initial: this.storage.loadProjects(),
      normalize: (data) => Storage.normalizeProjectsData(data as unknown as Record<string, unknown>),
      persist: (data) => this.storage.saveProjects(data),
      broadcast: (envelope) => this.broadcastToAllWindows('projects-updated', envelope)
    })
    // Notes only gained a canonical copy in main when they gained a revision: before
    // that `notes-save` proxied straight to disk, which is why note changes never
    // reached the other windows at all.
    this.notesStore = new RevisionStore<NotesRecord>({
      initial: this.notesStorage.load(),
      persist: (data) => this.notesStorage.save(data),
      broadcast: (envelope) => this.broadcastToAllWindows('notes-updated', envelope)
    })
    this.config = this.storage.loadConfig()
    setPortableNodeDir(this.config.portableNodeDir)
    this.sleepBlocker = new SleepBlocker(
      powerSaveBlocker,
      () => this.activityRegistry.getSnapshot(),
      () => this.config.keepAwakeWhileWorking !== false,
      (message) => this.logDebug(message)
    )
    this.activityRegistry.subscribe(() => this.sleepBlocker.update())
    this.ptySessions = new PtySessions({
      ptyManager: this.ptyManager,
      scrollbackStorage: this.scrollbackStorage,
      activityRegistry: this.activityRegistry,
      sshManager: () => this.sshManager,
      hookInjector: () => this.hookInjector,
      hookPort: () => this.hookServer.getPort(),
      hookToken: () => this.hookServer.getToken(),
      getConfig: () => this.config,
      broadcastAgentActivity: (tabId) => this.broadcastAgentActivity(tabId),
      sendToWindow: (windowId, channel, ...args) => this.sendToWindow(windowId, channel, ...args),
      log: (message) => this.logDebug(message),
      condaEnvForProject: (projectId) => this.condaEnvForLocalProject(projectId),
      onKill: (tabId) => this.shutdownNotebookKernel(tabId)
    })
    this.startupWindowStates = this.storage.loadWindowSession(
      this.projectsStore.peek(),
      this.config.defaultSidebarTab
    ).windows
  }

  /**
   * The one write path for canonical projects state from inside main (idle cleanup
   * and anything after it). Going through here is what bumps the revision and tells
   * the windows, so a main-side deletion cannot be resurrected by a stale renderer.
   */
  commitProjects(next: ProjectsData): ProjectsData {
    return this.projectsStore.commit(next).data
  }

  getProjectsData(): ProjectsData {
    return this.projectsStore.peek()
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.hookServer.start()
    this.logDebug(`start hookPort=${this.hookServer.getPort()}`)
    this.hookInjector = new HookInjector(this.hookServer.getPort(), this.hookServer.getToken())
    this.sshManager = new SshConnectionManager(path.join(CONFIG_DIR, 'ssh'), this.hookServer.getPort())
    this.notebookKernels.onEvent((tabId, event) => {
      this.broadcastToAllWindows('notebook-kernel-event', tabId, event)
    })
    this.chatManager = this.createChatManager()
    this.mobileService = this.createMobileService()
    this.updates = this.createUpdates()
    this.registerEventForwarders()
    this.registerIpcHandlers()
    this.mobileService.start()
    this.updates.start()
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
      autoCheck: () => this.config.autoCheckUpdates !== false,
      broadcast: (status) => this.broadcastToAllWindows('updates-status', status),
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

  private createMobileService(): MobileService {
    const mobileDir = path.join(CONFIG_DIR, 'mobile')
    const log = (message: string) => this.logDebug(message)
    // Loaded on first use (Mobile on, or a pairing started), never at startup:
    // safeStorage can raise a Keychain prompt on macOS.
    const identity = new IdentityStore(mobileDir, {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plaintext) => safeStorage.encryptString(plaintext),
      decrypt: (ciphertext) => safeStorage.decryptString(ciphertext)
    }, log)
    const desktopName = () => normalizeMobileConfig(this.config.mobile).desktopName?.trim() || os.hostname().replace(/\.local$/, '')
    // The emitter and the service need each other: it sends through the service, and
    // the bridge (inside the service's deps) tells it which turns a phone started.
    let service: MobileService | null = null
    let bridge: ChatBridge | null = null
    const push = new PushEmitter({
      chats: this.chatManager,
      projects: { peek: () => this.projectsStore.peek() },
      targets: () => service?.pushTargets() ?? [],
      openTab: (phoneId) => bridge?.openTab(phoneId) ?? null,
      send: (phoneId, data) => service?.sendPush(phoneId, data) ?? Promise.resolve('not-sent'),
      desktopId: () => identity.peekId(),
      now: () => Date.now(),
      log
    })
    bridge = new ChatBridge({
      chats: this.chatManager,
      projects: { peek: () => this.projectsStore.peek() },
      timers: {
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      log,
      onPhoneSend: (phoneId, tabId) => push.phoneSent(phoneId, tabId)
    })
    push.start()
    service = new MobileService({
      getConfig: () => normalizeMobileConfig(this.config.mobile),
      saveConfig: (mobile) => this.applyConfig({ mobile }),
      projects: {
        peek: () => this.projectsStore.peek(),
        subscribe: (listener) => this.projectsStore.subscribe(() => listener())
      },
      activity: this.activityRegistry,
      pairings: new PairingsStore(mobileDir, log),
      getDesktopId: () => identity.peekId(),
      defaultDesktopName: () => os.hostname().replace(/\.local$/, ''),
      createTransport: () => new RelayClient({
        ed25519: () => identity.get().ed25519,
        deviceId: () => identity.get().id,
        log: (message) => this.logDebug(`mobile ${message}`)
      }),
      channels: createNoiseChannelFactory({
        staticKey: () => identity.get().x25519,
        app: `devtool/${app.getVersion()}`,
        desktopName,
        features: () => [CHAT_NEW_FEATURE],
        log
      }),
      createInvite: (options) => createInvite(identity.get(), options),
      broadcastState: (state) => this.broadcastToAllWindows('mobile-state-changed', state),
      log,
      chat: bridge,
      newChat: (taskId) => {
        if (!this.config.enableClaude) {
          return { ok: false, code: AppErrorCode.Unsupported, message: 'Claude is turned off on this desktop' }
        }
        const added = addChatTab(this.projectsStore.peek(), taskId)
        if (!added.ok) return added
        this.commitProjects(added.data)
        return { ok: true, tabId: added.tabId }
      }
    })
    return service
  }

  registerWindow(window: BrowserWindow, initialViewState?: WindowViewState | null): void {
    this.windows.set(window.id, window)
    this.windowStates.set(window.id, {
      geometry: getWindowGeometry(window),
      viewState: initialViewState
        ? cloneWindowViewState(initialViewState)
        : buildWindowViewState(this.projectsStore.peek().projects, this.config)
    })
    this.logDebug(`registerWindow windowId=${window.id}`)
    this.scheduleIdleCleanup()
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
      // A closed window's unsaved buffers went with it; leaving them behind would
      // protect their tasks from cleanup forever.
      this.dirtyTabsByWindow.delete(window.id)
      for (const [tabId, windowId] of this.statusReporters) {
        if (windowId !== window.id) continue
        this.statusReporters.delete(tabId)
        this.activityRegistry.unreported(tabId)
      }
      if (!this.quitting) {
        this.windowStates.delete(window.id)
        this.persistWindowSession()
      }
      this.chatManager.detachWindow(window.id)
      this.ptySessions.detachWindow(window.id)
    })
  }

  getStartupWindowStates(): PersistedWindowState[] {
    return this.startupWindowStates.map((state) => clonePersistedWindowState(state))
  }

  prepareForQuit(): void {
    this.quitting = true
  }

  /**
   * Idle-task cleanup runs here, not in a renderer. A window's picture of what is
   * running is per-window by construction, so the window that happened to be asked
   * could not see an agent working in another one and deleted it anyway (finding
   * #7). Main receives every hook event, owns every PTY and knows every window's
   * selection, so it is the only process that can answer "is this safe to delete?".
   */
  private scheduleIdleCleanup(): void {
    if (this.idleCleanupScheduled) return
    this.idleCleanupScheduled = true
    setTimeout(() => void this.runIdleCleanup(), IDLE_CLEANUP_STARTUP_DELAY_MS)
    this.idleCleanupTimer = setInterval(() => void this.runIdleCleanup(), IDLE_CLEANUP_INTERVAL_MS)
  }

  /** One sweep at a time: the hourly tick must not overlap a sweep still awaiting git. */
  private async runIdleCleanup(): Promise<void> {
    if (this.idleCleanupRunning) return
    this.idleCleanupRunning = true
    try {
      await runIdleCleanupSweep(this.idleCleanupEnvironment())
    } catch (err) {
      this.logDebug(`idleCleanupFailed error=${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.idleCleanupRunning = false
    }
  }

  private idleCleanupEnvironment(): IdleCleanupEnvironment {
    return {
      readProjects: () => {
        const data = this.projectsStore.peek()
        return { projects: data.projects, pinnedItems: data.pinnedItems ?? [] }
      },
      readConfig: () => this.config.idleTaskCleanup,
      readActivity: () => this.getCleanupActivity(),
      now: () => Date.now(),
      backupProjects: () => this.storage.backupProjectsOnStartup(),
      deleteWorkspace: (project, task) => this.deleteTaskWorkspace(project, task),
      removeTask: (project, task) => this.removeTaskFromMain(project, task),
      forgetWorkspace: (project, task) => this.forgetTaskWorkspace(project, task),
      log: (message) => this.logDebug(message)
    }
  }

  /** Tasks selected in any window — only this process sees all of them. */
  private getOpenTaskIds(): string[] {
    const ids = new Set<string>()
    for (const state of this.windowStates.values()) {
      if (state.viewState.selectedTaskId) ids.add(state.viewState.selectedTaskId)
    }
    return [...ids]
  }

  /** Tabs whose process is still running, including ones no window currently shows. */
  private getLiveTabIds(): string[] {
    return [...this.ptySessions.liveTabIds(), ...this.chatManager.liveTabIds()]
  }

  private getDirtyTabIds(): string[] {
    const ids = new Set<string>()
    for (const tabIds of this.dirtyTabsByWindow.values()) {
      for (const tabId of tabIds) ids.add(tabId)
    }
    return [...ids]
  }

  private async deleteTaskWorkspace(project: Project, task: Task) {
    if (!task.workspace) return { status: 'ok' as const }
    // No `force`: this both checks that the worktree is clean and the branch merged
    // *and* performs the deletion when it is. Anything else leaves it untouched.
    return this.deleteWorkspace({
      projectDir: project.ssh ? project.ssh.remoteDir : project.directory,
      projectId: project.ssh ? project.id : undefined,
      sshConfig: project.ssh,
      worktreePath: task.workspace.worktreePath,
      branchName: task.workspace.branchName,
      baseBranch: task.workspace.baseBranch
    })
  }

  /** The worktree is gone but the task stayed: leave no record pointing at nothing. */
  private forgetTaskWorkspace(project: Project, task: Task): void {
    this.logDebug(`idleCleanupWorkspaceOrphaned project=${project.id} task=${task.id}`)
    const data = this.projectsStore.peek()
    this.commitProjects({
      ...data,
      projects: data.projects.map(candidate => candidate.id !== project.id ? candidate : {
        ...candidate,
        tasks: candidate.tasks.map(existing => {
          if (existing.id !== task.id) return existing
          const { workspace: _gone, ...rest } = existing
          return rest
        })
      })
    })
  }

  /**
   * Delete a task on main's own behalf, doing here every piece of teardown
   * `useAppState.removeTask` does in a window — the PTYs (which outlive a hidden
   * tab), the scrollback files, the hook injections and the activity entries.
   * A renderer only tears down tabs it has mounted, so nothing here may be left
   * to the broadcast; the broadcast covers only what is renderer-local (xterm
   * instances, per-window status entries, view state).
   */
  private async removeTaskFromMain(project: Project, task: Task): Promise<void> {
    const tabIds = await tearDownTaskTabs(project, task, {
      killPty: (tabId) => {
        this.ptySessions.discard(tabId)
        this.chatManager.close(tabId)
      },
      deleteScrollback: (tabId) => this.scrollbackStorage.delete(tabId),
      forgetActivity: (tabId) => {
        this.statusReporters.delete(tabId)
        this.activityRegistry.remove(tabId)
        this.broadcastAgentActivity(tabId)
      },
      releaseHooks: (owner, dir, tabId) => owner.ssh
        ? this.cleanupRemoteHooks(owner.id, owner.ssh, dir, tabId)
        : this.hookInjector.cleanup(dir, tabId)
    })

    // Sent before the state commit, and on the same ordered channel: a window that
    // learns the task is gone first unmounts its tabs, and the components that own
    // the xterm instances and status entries would no longer be listening.
    this.broadcastToAllWindows('tasks-removed', { projectId: project.id, taskId: task.id, tabIds })

    const data = this.projectsStore.peek()
    this.commitProjects({
      ...data,
      projects: data.projects.map(candidate =>
        candidate.id === project.id
          ? { ...candidate, tasks: candidate.tasks.filter(existing => existing.id !== task.id) }
          : candidate
      )
    })

    // Main's own copy of each window's selection is what gets persisted on quit,
    // so it has to forget the task too.
    for (const [windowId, state] of this.windowStates.entries()) {
      const taskStates = { ...state.viewState.taskStates }
      const hadTaskState = task.id in taskStates
      const wasSelected = state.viewState.selectedTaskId === task.id
      if (!hadTaskState && !wasSelected) continue
      delete taskStates[task.id]
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
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer)
      this.idleCleanupTimer = null
    }
    this.persistWindowSession()
    this.mobileService?.stop()
    this.updates?.close()
    this.ptySessions.saveAllScrollback()
    this.ptySessions.killAll()
    this.notebookKernels.shutdownAll()
    this.chatManager.closeAll()
    this.sleepBlocker.release()
    this.hookInjector.cleanupAll()
    await this.hookServer.stop()
    await this.sshManager.disconnectAll().catch(() => {})
  }

  private registerEventForwarders(): void {
    for (const endpoint of ['session-start', 'working', 'stopped', 'notification', 'activity']) {
      this.hookServer.on(endpoint, (tabId: string, body: Record<string, unknown>) => this.handleHook(endpoint, tabId, body))
    }

    this.sshManager.on('status-changed', async (projectId: string, status: string) => {
      this.logDebug(`sshStatus projectId=${projectId} status=${status}`)
      this.broadcastToAllWindows('ssh-status-changed', projectId, status)

      if (status === 'disconnected' && this.socksProxyEnabled.get(projectId)) {
        await routeBrowserDirectQuietly(projectId)
        this.broadcastToAllWindows('socks-proxy-status-changed', projectId, false)
      }

      if (status === 'connected') {
        await this.restoreSocksProxy(projectId)
      }
    })

    this.sshManager.on('tunnel-status-changed', (projectId: string, status: string, error?: string) => {
      this.logDebug(`tunnelStatus projectId=${projectId} status=${status}${error ? ` error=${error}` : ''}`)
      this.broadcastToAllWindows('ssh-tunnel-status-changed', projectId, status, error)
    })

    this.sshManager.on('socks-proxy-status-changed', async (projectId: string, enabled: boolean) => {
      if (!enabled) {
        await routeBrowserDirectQuietly(projectId)
        this.broadcastToAllWindows('socks-proxy-status-changed', projectId, false)

        const config = this.sshManager.getConfig(projectId)
        if (this.socksProxyEnabled.get(projectId) && config && this.sshManager.getStatus(projectId) === 'connected') {
          try {
            const port = await this.sshManager.startSocksProxy(projectId, config)
            await routeBrowserThroughSocks(projectId, port)
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

  /**
   * One hook event, from a terminal tab's curl (hook server) or a chat tab's SDK
   * process (in-process). Each has two consumers: the windows, which draw the
   * status dot for the tabs they mount, and the activity registry, which is what
   * idle cleanup and the sidebar's activity line read.
   */
  private handleHook(endpoint: string, tabId: string, body: Record<string, unknown>): void {
    switch (endpoint) {
      case 'session-start':
        this.activityRegistry.touch(tabId)
        this.recordAgentActivity(tabId, body)
        this.broadcastToAttachedWindows(tabId, 'hook-session-start', tabId, body)
        return
      case 'working':
        this.activityRegistry.working(tabId)
        this.recordAgentActivity(tabId, body)
        this.broadcastToAttachedWindows(tabId, 'hook-working', tabId)
        return
      case 'stopped':
        this.activityRegistry.stopped(tabId)
        this.recordAgentActivity(tabId, body)
        this.broadcastToAttachedWindows(tabId, 'hook-stopped', tabId)
        return
      case 'notification':
        this.activityRegistry.notification(tabId, body)
        this.recordAgentActivity(tabId, body)
        this.broadcastToAttachedWindows(tabId, 'hook-notification', tabId, body)
        return
      default: {
        // Everything else Claude reports (tools, permission dialogs, API failures,
        // subagents, compaction). `hook-activity` is sent even without a status
        // change, because any hook proves the agent is alive (the stale-working timer).
        const update = this.recordAgentActivity(tabId, body)
        const statusEvent = update?.statusEvent ?? null
        if (statusEvent) this.activityRegistry.statusEvent(tabId, statusEvent)
        this.broadcastToAttachedWindows(tabId, 'hook-activity', tabId, statusEvent)
      }
    }
  }

  private createChatManager(): ClaudeChatManager {
    return new ClaudeChatManager({
      sendToWindow: (windowId, channel, ...args) => this.sendToWindow(windowId, channel, ...args),
      resolveLocalClaude: () => resolveAgentCommand(agentCommandOverride('claude', this.config).trim() || 'claude'),
      localEnv: () => getShellEnv(),
      ensureSsh: (projectId, sshConfig) => this.ensureSshConnected(projectId, sshConfig),
      remoteCommand: (projectId, sshConfig, cwd, claudeArgs, env) => ({
        file: this.sshManager.getSshCommand(),
        args: this.sshManager.buildStdioSpawnArgs(projectId, sshConfig, 'claude', claudeArgs, env, cwd)
      }),
      bashSpawn: (config, command) => {
        if (config.sshConfig && config.projectId) {
          return {
            file: this.sshManager.getSshCommand(),
            args: this.sshManager.buildStdioSpawnArgs(config.projectId, config.sshConfig, 'bash', ['-c', command], {}, config.cwd)
          }
        }
        const env = getShellEnv()
        const shell = process.platform === 'win32'
          ? findGitBashExe() ?? 'bash.exe'
          : env.SHELL || '/bin/sh'
        return { file: shell, args: ['-c', command], cwd: config.cwd, env }
      },
      remoteExec: async (projectId, sshConfig, script) => {
        const { stdout } = await execFileAsync(this.sshManager.getSshCommand(), [
          '-S', this.sshManager.getSocketPath(projectId),
          `${sshConfig.username}@${sshConfig.host}`,
          script
        ], { timeout: 30_000, maxBuffer: 512 * 1024 * 1024 })
        return stdout
      },
      onHook: (tabId, body) => {
        const event = typeof body.hook_event_name === 'string' ? body.hook_event_name : ''
        this.handleHook(hookEndpointFor(event), tabId, body)
      },
      onPromptResolved: (tabId, prompt) => {
        this.handleHook('activity', tabId, { hook_event_name: 'DevtoolPromptResolved', tool_use_id: prompt.toolUseId })
      },
      onProcessChange: (tabId, running, error) => {
        // A fresh process says nothing about the old one's status; an ended one is
        // 'exited' only when it died on its own — a chat restarts on the next send.
        if (running || !error) this.activityRegistry.reset(tabId)
        else this.activityRegistry.exited(tabId)
        this.broadcastAgentActivity(tabId)
      },
      log: (message) => this.logDebug(message)
    })
  }

  private async ensureSshConnected(projectId: string, sshConfig: SshConfig): Promise<void> {
    if (this.sshManager.getStatus(projectId) === 'connected') return
    await this.sshManager.connect(projectId, sshConfig, { tunnel: this.getProjectTunnel(projectId) ?? null })
    this.sshManager.startHealthChecks(projectId, sshConfig)
  }

  /** Restore the SOCKS proxy the user enabled for a project. Runs on every
   *  transition into 'connected' — manual connect and auto-reconnect alike — so
   *  a recovered connection isn't left without the proxy that was configured. */
  private async restoreSocksProxy(projectId: string): Promise<void> {
    if (!this.socksProxyEnabled.get(projectId)) return
    if (this.sshManager.getSocksProxy(projectId)) return
    const sshConfig = this.sshManager.getConfig(projectId)
    if (!sshConfig) return
    try {
      const port = await this.sshManager.startSocksProxy(projectId, sshConfig)
      await routeBrowserThroughSocks(projectId, port)
      this.broadcastToAllWindows('socks-proxy-status-changed', projectId, true, port)
    } catch {
      // Keep SSH connected even when restoring the SOCKS proxy fails.
    }
  }

  private registerIpcHandlers(): void {
    const log = (message: string) => this.logDebug(message)
    const isAppUrl = createAppUrlMatcher(process.env.ELECTRON_RENDERER_URL)
    const ipc = createIpcRegistrar({
      ipcMain,
      senderPolicy: {
        isAppWebContents: (webContentsId) => {
          for (const window of this.windows.values()) {
            if (!window.isDestroyed() && window.webContents.id === webContentsId) return true
          }
          return false
        },
        isAppUrl
      },
      log
    })
    const resolveRoot = (dir: string) => this.resolveAllowedDirectory(dir)

    registerAppStateHandlers(ipc, {
      projectsStore: this.projectsStore,
      notesStore: this.notesStore,
      paletteFrecency: this.paletteFrecencyStorage,
      getAgentActivity: () => this.activityRegistry.getActivitySnapshot(),
      getCleanupActivity: () => this.getCleanupActivity(),
      reportTabStatus: (windowId, tabId, status) => {
        this.statusReporters.set(tabId, windowId)
        this.activityRegistry.reported(tabId, status)
      },
      setDirtyTabs: (windowId, tabIds) => {
        if (tabIds.length === 0) this.dirtyTabsByWindow.delete(windowId)
        else this.dirtyTabsByWindow.set(windowId, new Set(tabIds))
      },
      backupProjects: () => this.storage.backupProjectsOnStartup(),
      getConfig: () => this.config,
      applyConfig: (patch) => this.applyConfig(patch),
      log
    })

    registerWindowHandlers(ipc, {
      loadViewState: (windowId) => {
        const state = windowId !== null ? this.windowStates.get(windowId) ?? null : null
        return state
          ? cloneWindowViewState(state.viewState)
          : buildWindowViewState(this.projectsStore.peek().projects, this.config)
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
      getConfig: () => this.config,
      assertAllowedDirectory: resolveRoot
    })

    registerSshHandlers(ipc, {
      sshManager: () => this.sshManager,
      getProjectTunnel: (projectId) => this.getProjectTunnel(projectId),
      socksProxyEnabled: this.socksProxyEnabled,
      socksProxyStarting: this.socksProxyStarting,
      broadcast: (channel, ...args) => this.broadcastToAllWindows(channel, ...args),
      log
    })

    registerAgentHandlers(ipc, {
      sshManager: () => this.sshManager,
      hookInjector: () => this.hookInjector,
      codexSessionManager: this.codexSessionManager,
      chatManager: () => this.chatManager,
      ensureSshConnected: (projectId, sshConfig) => this.ensureSshConnected(projectId, sshConfig),
      cleanupRemoteHooks: (projectId, sshConfig, remoteDir, tabId) =>
        this.cleanupRemoteHooks(projectId, sshConfig, remoteDir, tabId),
      forgetActivity: (tabId) => {
        this.statusReporters.delete(tabId)
        this.activityRegistry.remove(tabId)
        this.broadcastAgentActivity(tabId)
      },
      assertAllowedDirectory: resolveRoot
    })

    registerTerminalHandlers(ipc, { ptySessions: this.ptySessions, log })

    registerWorkspaceHandlers(ipc, {
      workspaceManager: this.workspaceManager,
      remoteWorkspaceManager: this.remoteWorkspaceManager,
      ensureSshConnected: (projectId, sshConfig) => this.ensureSshConnected(projectId, sshConfig),
      socketPath: (projectId) => this.sshManager.getSocketPath(projectId),
      deleteWorkspace: (request) => this.deleteWorkspace(request)
    })

    registerFileBrowserHandlers(ipc, { resolveRoot })
    registerGitHandlers(ipc, { resolveRoot })
    registerNotebookHandlers(ipc, {
      startKernel: (tabId, projectId, cwd, override) => this.startNotebookKernel(tabId, projectId, cwd, override),
      execute: (tabId, requestId, code, cellId) => this.notebookKernels.execute(tabId, requestId, code, cellId),
      interrupt: (tabId) => this.notebookKernels.interrupt(tabId),
      shutdown: (tabId) => this.shutdownNotebookKernel(tabId),
      listCondaEnvs: () => listCondaEnvs({}, { force: true })
    })
    registerMobileHandlers(ipc, { mobile: () => this.mobileService })
    registerUpdateHandlers(ipc, { updates: () => this.updates })
  }

  /**
   * A renderer-supplied local directory, accepted only when it is (inside) a
   * known local project or one of its task worktrees; returns its real path.
   */
  private resolveAllowedDirectory(dir: string): Promise<string> {
    return resolveAllowedDirectory(dir, allowedLocalRoots(this.projectsStore.peek().projects))
  }

  private getCleanupActivity(): CleanupActivity {
    return {
      openTaskIds: this.getOpenTaskIds(),
      statuses: this.activityRegistry.getSnapshot(),
      liveTabIds: this.getLiveTabIds(),
      dirtyTabIds: this.getDirtyTabIds()
    }
  }

  private applyConfig(patch: Partial<AppConfig>): void {
    this.config = { ...this.config, ...patch }
    this.storage.saveConfig(this.config)
    setPortableNodeDir(this.config.portableNodeDir)
    this.sleepBlocker.update()
    this.broadcastToAllWindows('config-updated', clone(this.config))
  }

  /** Shared by the `workspace-delete` IPC and the idle sweep, which runs it with no `force`. */
  private async deleteWorkspace(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteResult> {
    if (request.sshConfig && request.projectId) {
      await this.ensureSshConnected(request.projectId, request.sshConfig)
      return this.remoteWorkspaceManager.delete(this.sshManager.getSocketPath(request.projectId), {
        ...request,
        projectId: request.projectId,
        sshConfig: request.sshConfig
      })
    }
    return this.workspaceManager.delete(request)
  }

  /** Release a tab's remote hook injection, running the remote script for the last owner. */
  private async cleanupRemoteHooks(
    projectId: string,
    sshConfig: SshConfig,
    remoteDir: string | undefined,
    tabId: string
  ): Promise<void> {
    const effectiveRemoteDir = remoteDir || sshConfig.remoteDir
    const isLast = this.hookInjector.remoteCleanup(projectId, effectiveRemoteDir, tabId)
    if (!isLast) return

    if (this.sshManager.getStatus(projectId) !== 'connected') return
    const cleanupScript = this.hookInjector.buildRemoteCleanupScript(effectiveRemoteDir)
    const cleanupArgs = [
      '-S', this.sshManager.getSocketPath(projectId),
      `${sshConfig.username}@${sshConfig.host}`,
      cleanupScript
    ]
    try {
      await execFileAsync(this.sshManager.getSshCommand(), cleanupArgs, { timeout: 5000 })
    } catch {
      // Best-effort cleanup
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

  /**
   * Fold a hook body into the tab's activity and push it to every window — the
   * sidebar lists tasks that are not mounted in the window showing them.
   */
  private recordAgentActivity(tabId: string, body: Record<string, unknown>): ActivityUpdate | null {
    const update = this.activityRegistry.applyHook(tabId, body)
    if (update) this.broadcastToAllWindows('agent-activity', tabId, update.activity)
    return update
  }

  private broadcastAgentActivity(tabId: string): void {
    this.broadcastToAllWindows('agent-activity', tabId, this.activityRegistry.getActivity(tabId))
  }

  private broadcastToAllWindows(channel: string, ...args: unknown[]): void {
    for (const window of this.windows.values()) {
      safeWebContentsSend(window, channel, ...args)
    }
  }

  /** Local PTYs only. Remote tabs run on the SSH host, which has its own python. */
  private condaEnvForLocalProject(projectId?: string): CondaEnvInfo | undefined {
    if (!projectId) return undefined
    const project = this.projectsStore.peek().projects.find((item) => item.id === projectId)
    if (!project) return undefined
    const resolved = resolveProjectCondaEnv(project)
    if (!resolved) {
      if (project.condaEnvName?.trim() || project.condaEnvPrefix?.trim()) {
        this.logDebug(
          `condaEnv missing name=${project.condaEnvName ?? ''} prefix=${project.condaEnvPrefix ?? ''} projectId=${projectId}`
        )
      }
      return undefined
    }
    this.logDebug(`condaEnv name=${resolved.name} prefix=${resolved.prefix} projectId=${projectId}`)
    return resolved
  }

  /** Cancels a start still waiting on the conda lookup, then stops a running kernel. */
  private shutdownNotebookKernel(tabId: string): void {
    this.pendingNotebookStarts.delete(tabId)
    this.notebookKernels.shutdown(tabId)
  }

  private async startNotebookKernel(
    tabId: string,
    projectId: string,
    cwd: string,
    condaOverride?: NotebookKernelCondaOverride | null
  ): Promise<{ error?: string; code?: string }> {
    const fail = (code: string, message: string): { error: string; code: string } => {
      this.broadcastToAllWindows('notebook-kernel-event', tabId, { event: 'fail', code, message })
      return { error: message, code }
    }
    const project = this.projectsStore.peek().projects.find((item) => item.id === projectId)
    if (!project) return { error: 'Project not found.', code: 'no-project' }
    if (isRemoteProject(project)) return fail('remote', NOTEBOOK_ERROR_REMOTE)
    if (isShellCommandProject(project)) return fail('shell-project', NOTEBOOK_ERROR_SHELL_PROJECT)
    const cwdResult = resolveNotebookKernelCwd(cwd, notebookAllowedCwdRoots(project))
    if (!cwdResult.ok) return fail('cwd', cwdResult.error)
    const override = condaOverride
      ? { condaEnvName: condaOverride.name, condaEnvPrefix: condaOverride.prefix }
      : null
    const hasOverride = !!(override?.condaEnvName?.trim() || override?.condaEnvPrefix?.trim())
    const token = ++this.notebookStartCounter
    this.pendingNotebookStarts.set(tabId, token)
    // Override: live conda list only. No override: existing project-default resolve.
    const listedEnvs = hasOverride ? await listCondaEnvsForNotebookKernel() : []
    // The tab was closed (or a newer start began) while conda was listing envs.
    if (this.pendingNotebookStarts.get(tabId) !== token) return {}
    this.pendingNotebookStarts.delete(tabId)
    const projectResolved = hasOverride ? null : resolveProjectCondaEnv(project)
    const resolved = resolveNotebookKernelCondaEnv(override, project, listedEnvs, projectResolved, process.platform)
    if (!resolved.ok) return fail(resolved.code, resolved.error)
    const condaEnv = resolved.env ?? undefined
    this.logDebug(
      `notebookKernelStart tabId=${tabId} projectId=${projectId} cwd=${cwdResult.cwd} conda=${condaEnv?.name ?? ''} prefix=${condaEnv?.prefix ?? ''}`
    )
    return this.notebookKernels.start(tabId, condaEnv, cwdResult.cwd)
  }

  private getProjectTunnel(projectId: string): TunnelConfig | undefined {
    return this.projectsStore.peek().projects.find((project) => project.id === projectId)?.tunnel
  }

  private broadcastToAttachedWindows(tabId: string, channel: string, ...args: unknown[]): void {
    const windowIds = this.ptySessions.attachedWindows(tabId) ?? this.chatManager?.attachedWindows(tabId)
    if (!windowIds) return
    for (const windowId of windowIds) this.sendToWindow(windowId, channel, ...args)
  }

  private sendToWindow(windowId: number, channel: string, ...args: unknown[]): void {
    const window = this.windows.get(windowId)
    if (window) safeWebContentsSend(window, channel, ...args)
  }
}

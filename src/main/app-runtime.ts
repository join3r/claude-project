import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Storage } from './storage'
import { CONFIG_DIR } from './config-dir'
import { ScrollbackStorage } from './scrollback-storage'
import { PtyManager } from './pty-manager'
import { HookServer } from './hook-server'
import { HookInjector } from './hook-injector'
import { SshConnectionManager } from './ssh-connection-manager'
import { CodexSessionManager } from './codex-session-manager'
import { RemoteWorkspaceManager } from './remote-workspace-manager'
import { WorkspaceManager } from './workspace-manager'
import { NotesStorage } from './notes-storage'
import { RevisionStore } from './revision-store'
import { TabActivityRegistry } from './tab-activity-registry'
import { runIdleCleanupSweep, type IdleCleanupEnvironment } from './idle-cleanup-sweep'
import { tearDownTaskTabs } from './task-teardown'
import { PaletteFrecencyStorage, type FrecencyFile } from './palette-frecency-storage'
import { parseNumstat } from './git-diff-summary'
import { GIT_STATUS_ARGS, parseGitStatusZ } from './git-status-parse'
import { AI_TAB_META } from '../shared/types'
import {
  piExtensionLocalPath,
  piExtensionRemotePath,
  buildRemotePiExtensionScript
} from './pi-extension-injector'
import type {
  AppConfig,
  CommitHistoryResult,
  DirectoryEntry,
  GitDiffSummary,
  GitPostureLastCommit,
  GitPostureResult,
  GitStatusResult,
  GitOperationResult,
  PersistedWindowState,
  Project,
  ProjectsData,
  SshConfig,
  Task,
  TunnelConfig,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResult,
  WorkspaceListBranchesRequest,
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
import fsPromises from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const MAX_SCROLLBACK_CHARS = 2_000_000
/**
 * Let the windows come up before the first sweep: what is on screen, which
 * buffers are unsaved and which PTYs are alive are all safeguards main only
 * learns once the renderers have reported in.
 */
const IDLE_CLEANUP_STARTUP_DELAY_MS = 15_000
const IDLE_CLEANUP_INTERVAL_MS = 60 * 60_000
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

async function hasHeadCommit(resolvedCwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: resolvedCwd })
    return true
  } catch {
    return false
  }
}

async function readUntrackedSummary(resolvedCwd: string): Promise<GitDiffSummary> {
  try {
    // Count lines via a shell pipeline instead of reading every untracked file
    // into Node.js — projects with hundreds of untracked files (e.g. vendored
    // dependencies) would otherwise cause 100% CPU on the 2-second poll.
    const { stdout } = await execFileAsync(
      '/bin/sh',
      ['-c', 'git ls-files --others --exclude-standard -z | xargs -0 wc -l 2>/dev/null | tail -1'],
      { cwd: resolvedCwd, timeout: 5000 }
    )
    const added = parseInt(stdout.trim(), 10) || 0
    return { added, deleted: 0 }
  } catch {
    return { added: 0, deleted: 0 }
  }
}

async function readGitDiffSummary(resolvedCwd: string): Promise<GitDiffSummary> {
  const untrackedSummary = await readUntrackedSummary(resolvedCwd)

  try {
    const diffArgs = await hasHeadCommit(resolvedCwd)
      ? ['diff', '--numstat', 'HEAD', '--']
      : ['diff', '--numstat', '--cached', '--']
    const { stdout } = await execFileAsync('git', diffArgs, { cwd: resolvedCwd })
    const trackedSummary = parseNumstat(stdout)
    return {
      added: trackedSummary.added + untrackedSummary.added,
      deleted: trackedSummary.deleted + untrackedSummary.deleted
    }
  } catch {
    return untrackedSummary
  }
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
  private readonly hookServer = new HookServer((message) => this.logDebug(message))
  private readonly codexSessionManager = new CodexSessionManager()
  private readonly workspaceManager = new WorkspaceManager()
  private readonly remoteWorkspaceManager = new RemoteWorkspaceManager()
  private readonly windows = new Map<number, BrowserWindow>()
  private readonly windowStates = new Map<number, PersistedWindowState>()
  private readonly ptyRuntimes = new Map<string, PtyRuntime>()
  /** Main's authoritative view of what every tab's agent is doing. */
  private readonly activityRegistry = new TabActivityRegistry()
  /** Tabs with an unsaved editor buffer, per window — a task holding one is not swept. */
  private readonly dirtyTabsByWindow = new Map<number, Set<string>>()
  private hookInjector!: HookInjector
  private sshManager!: SshConnectionManager
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
      readActivity: () => ({
        openTaskIds: this.getOpenTaskIds(),
        statuses: this.activityRegistry.getSnapshot(),
        liveTabIds: this.getLiveTabIds(),
        dirtyTabIds: this.getDirtyTabIds()
      }),
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
    const ids: string[] = []
    for (const [tabId, runtime] of this.ptyRuntimes.entries()) {
      if (runtime.exitCode === null) ids.push(tabId)
    }
    return ids
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
        this.ptyManager.kill(tabId)
        this.ptyRuntimes.delete(tabId)
      },
      deleteScrollback: (tabId) => this.scrollbackStorage.delete(tabId),
      forgetActivity: (tabId) => this.activityRegistry.remove(tabId),
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
    for (const [tabId, runtime] of this.ptyRuntimes.entries()) {
      this.scrollbackStorage.save(tabId, runtime.scrollback)
    }
    this.ptyManager.killAll()
    this.hookInjector.cleanupAll()
    await this.hookServer.stop()
    await this.sshManager.disconnectAll().catch(() => {})
  }

  private registerEventForwarders(): void {
    // Each hook event now has two consumers: the windows, which draw the status dot
    // for the tabs they have mounted, and the activity registry, which is what idle
    // cleanup asks. The forwarding is unchanged — the registry is an addition.
    this.hookServer.on('session-start', (tabId: string, body: Record<string, unknown>) => {
      this.activityRegistry.touch(tabId)
      this.broadcastToAttachedWindows(tabId, 'hook-session-start', tabId, body)
    })

    this.hookServer.on('working', (tabId: string) => {
      this.activityRegistry.working(tabId)
      this.broadcastToAttachedWindows(tabId, 'hook-working', tabId)
    })

    this.hookServer.on('stopped', (tabId: string) => {
      this.activityRegistry.stopped(tabId)
      this.broadcastToAttachedWindows(tabId, 'hook-stopped', tabId)
    })

    this.hookServer.on('notification', (tabId: string, body: Record<string, unknown>) => {
      this.activityRegistry.notification(tabId, body)
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
      const ses = session.fromPartition(`persist:browser-${projectId}`)
      await ses.setProxy({
        proxyRules: `socks5://127.0.0.1:${port}`,
        proxyBypassRules: '<-loopback>'
      })
      await ses.closeAllConnections()
      this.broadcastToAllWindows('socks-proxy-status-changed', projectId, true, port)
    } catch {
      // Keep SSH connected even when restoring the SOCKS proxy fails.
    }
  }

  private registerIpcHandlers(): void {
    ipcMain.handle('load-projects', () => this.projectsStore.get())
    ipcMain.handle('save-projects', (_event, payload: { baseRevision: number; data: ProjectsData }) =>
      this.projectsStore.save(payload.baseRevision, payload.data))

    // Everything the sweep exempts a task for, as the settings preview needs to show
    // it: what is on screen in any window, what main has heard from the hooks, what
    // still has a process, and what has an unsaved buffer open.
    ipcMain.handle('get-cleanup-activity', () => ({
      openTaskIds: this.getOpenTaskIds(),
      statuses: this.activityRegistry.getSnapshot(),
      liveTabIds: this.getLiveTabIds(),
      dirtyTabIds: this.getDirtyTabIds()
    }))

    // Windows publish their unsaved editors: a background sweep has nobody to show a
    // Save/Discard dialog to, so a dirty buffer keeps its task out of the sweep.
    ipcMain.handle('report-dirty-tabs', (event, tabIds: string[]) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return undefined
      if (tabIds.length === 0) this.dirtyTabsByWindow.delete(window.id)
      else this.dirtyTabsByWindow.set(window.id, new Set(tabIds))
      return undefined
    })

    ipcMain.handle('backup-projects-now', () => this.storage.backupProjectsOnStartup())

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
        : buildWindowViewState(this.projectsStore.peek().projects, this.config)
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
      // `showOpenDialog` is overloaded on arity, not on an optional owner, so the
      // ownerless case has to be a separate call rather than passing undefined.
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0]
    })

    ipcMain.handle('pick-file', async (event, title?: string) => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: title || 'Select file',
        properties: ['openFile', 'showHiddenFiles']
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0]
    })

    ipcMain.handle('get-native-theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    ipcMain.handle('clipboard-write-text', (_event, text: string) => {
      clipboard.writeText(text)
      return undefined
    })
    ipcMain.handle('open-external', async (_event, url: string) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error('Invalid URL')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http and https URLs are allowed')
      }
      await shell.openExternal(parsed.toString())
    })

    ipcMain.handle('app:open-devtools', (event) => {
      BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools()
    })
    ipcMain.handle('app:quit', () => app.quit())

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

    ipcMain.handle('notes-load', () => this.notesStore.get())
    ipcMain.handle('notes-save', (_event, payload: { baseRevision: number; data: NotesRecord }) =>
      this.notesStore.save(payload.baseRevision, payload.data))

    ipcMain.handle('palette-frecency:load', () => this.paletteFrecencyStorage.load())
    ipcMain.handle('palette-frecency:save', (_event, file: FrecencyFile) => this.paletteFrecencyStorage.save(file))

    ipcMain.handle('ssh-connect', async (_event, projectId: string, sshConfig: SshConfig) => {
      // The tunnel and the SOCKS proxy are restored by the manager's connect
      // path and the 'connected' status handler respectively, so that automatic
      // reconnects go through exactly the same restoration as this one.
      await this.sshManager.connect(projectId, sshConfig, { tunnel: this.getProjectTunnel(projectId) ?? null })
      this.sshManager.startHealthChecks(projectId, sshConfig)
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
      this.logDebug(`socksProxyEnable projectId=${projectId} sshStatus=${this.sshManager.getStatus(projectId)}`)
      this.socksProxyEnabled.set(projectId, true)

      const pending = this.socksProxyStarting.get(projectId)
      if (pending) {
        const port = await pending
        return { port }
      }

      const startPromise = (async () => {
        this.logDebug(`socksProxyEnable starting proxy for ${projectId}`)
        const port = await this.sshManager.startSocksProxy(projectId, sshConfig)
        this.logDebug(`socksProxyEnable proxy started on port ${port}`)
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
        this.logDebug(`socksProxyEnable session configured for ${projectId} port=${port}`)
        this.broadcastToAllWindows('socks-proxy-status-changed', projectId, true, port)
        return port
      })()

      this.socksProxyStarting.set(projectId, startPromise)
      try {
        const port = await startPromise
        this.logDebug(`socksProxyEnable success projectId=${projectId} port=${port}`)
        return { port }
      } catch (err) {
        this.logDebug(`socksProxyEnable FAILED projectId=${projectId} error=${err instanceof Error ? err.message : String(err)}`)
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
      this.logDebug(`socksProxyStatus projectId=${projectId} hasEntry=${hasEntry} enabled=${enabled} port=${proxy?.port}`)
      return { enabled, port: proxy?.port }
    })

    ipcMain.handle('hooks-inject', (_event, projectDir: string, tabId: string) => {
      this.hookInjector.inject(projectDir, tabId)
    })
    ipcMain.handle('hooks-cleanup', (_event, projectDir: string, tabId: string) => {
      this.hookInjector.cleanup(projectDir, tabId)
    })
    ipcMain.handle('hooks-cleanup-remote', (_event, projectId: string, sshConfig: SshConfig, remoteDir: string | undefined, tabId: string) =>
      this.cleanupRemoteHooks(projectId, sshConfig, remoteDir, tabId))

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

    // Claude prunes old sessions (and never persists sessions that got no user
    // message), so a stored sessionId can go stale; spawning `claude --resume`
    // with it dies with "No conversation found". The renderer checks here first
    // and starts fresh when the session file is gone.
    ipcMain.handle('claude-session-exists', async (_event, cwd: string, sessionId: string, projectId?: string, sshConfig?: SshConfig) => {
      if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return false

      if (!sshConfig || !projectId) {
        const projectsDir = path.join(os.homedir(), '.claude', 'projects')
        const fileName = `${sessionId}.jsonl`
        // Claude derives the project dir name by replacing non-alphanumerics with '-'
        const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
        if (fs.existsSync(path.join(projectsDir, slug, fileName))) return true
        // Fallback sweep across all projects in case the slug derivation ever
        // diverges from Claude's — a hit anywhere preserves the resume attempt.
        try {
          return fs.readdirSync(projectsDir).some(dir => fs.existsSync(path.join(projectsDir, dir, fileName)))
        } catch {
          return false
        }
      }

      if (this.sshManager.getStatus(projectId) !== 'connected') {
        throw new Error('SSH connection not established')
      }
      const sshArgs = [
        '-S', this.sshManager.getSocketPath(projectId),
        `${sshConfig.username}@${sshConfig.host}`,
        `ls "$HOME"/.claude/projects/*/${sessionId}.jsonl >/dev/null 2>&1 && echo yes || echo no`
      ]
      const { stdout } = await execFileAsync('ssh', sshArgs, { timeout: 5000 })
      return stdout.trim() === 'yes'
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
        const resolvedShell = shell || process.env.SHELL || '/bin/sh'
        this.logDebug(`ptySpawnRequest windowId=${window.id} id=${id} shell=${resolvedShell} cwd=${cwd} cols=${cols} rows=${rows}`)
        return this.attachOrCreatePty(window.id, id, resolvedShell, cwd, cols, rows, args, extraEnv, projectId, sshConfig)
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

    ipcMain.handle('workspace-list-branches', async (_event, request: WorkspaceListBranchesRequest) => {
      if (request.sshConfig && request.projectId) {
        await this.ensureSshConnected(request.projectId, request.sshConfig)
        return this.remoteWorkspaceManager.listBranches(this.sshManager.getSocketPath(request.projectId), {
          ...request,
          projectId: request.projectId,
          sshConfig: request.sshConfig
        })
      }
      return this.workspaceManager.listBranches(request.projectDir)
    })

    ipcMain.handle('workspace-create', async (_event, request: WorkspaceCreateRequest) => {
      const result = request.sshConfig && request.projectId
        ? await (async () => {
            await this.ensureSshConnected(request.projectId!, request.sshConfig!)
            return this.remoteWorkspaceManager.create(this.sshManager.getSocketPath(request.projectId!), {
              ...request,
              projectId: request.projectId!,
              sshConfig: request.sshConfig!
            })
          })()
        : await this.workspaceManager.create(request.projectDir, request.name, request.baseBranch)
      return { ...result, baseBranch: request.baseBranch }
    })

    ipcMain.handle(
      'workspace-delete',
      (_event, request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteResult> => this.deleteWorkspace(request)
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

    ipcMain.handle('fb-git-status', async (_event, projectCwd: string): Promise<GitStatusResult> => {
      const resolvedCwd = path.resolve(projectCwd)
      try {
        const [{ stdout }, summary] = await Promise.all([
          execFileAsync('git', GIT_STATUS_ARGS, { cwd: resolvedCwd }),
          readGitDiffSummary(resolvedCwd)
        ])
        const { staged, unstaged, untracked } = parseGitStatusZ(stdout)

        return { staged, unstaged, untracked, summary }
      } catch {
        return {
          staged: [],
          unstaged: [],
          untracked: [],
          summary: { added: 0, deleted: 0 }
        }
      }
    })

    ipcMain.handle('fb-git-diff', async (_event, projectCwd: string, relativeFilePath: string): Promise<string> => {
      const resolvedCwd = path.resolve(projectCwd)
      try {
        // The trailing `--` keeps a path that starts with `-` from being read
        // as an option; the raw path is passed through untouched.
        const { stdout } = await execFileAsync('git', ['show', `HEAD:${relativeFilePath}`, '--'], { cwd: resolvedCwd })
        return stdout
      } catch {
        return ''
      }
    })

    ipcMain.handle('fb-git-stage', async (_event, projectCwd: string, files: string[]): Promise<GitOperationResult> => {
      const resolvedCwd = path.resolve(projectCwd)
      try {
        await execFileAsync('git', ['add', '--', ...files], { cwd: resolvedCwd, timeout: 10000 })
        return { success: true, message: `Staged ${files.length} file(s)` }
      } catch (err: unknown) {
        const stderr = (err as { stderr?: string })?.stderr?.trim()
        const msg = stderr || (err instanceof Error ? err.message : String(err))
        return { success: false, message: msg }
      }
    })

    ipcMain.handle('fb-git-unstage', async (_event, projectCwd: string, files: string[]): Promise<GitOperationResult> => {
      const resolvedCwd = path.resolve(projectCwd)
      try {
        await execFileAsync('git', ['reset', 'HEAD', '--', ...files], { cwd: resolvedCwd, timeout: 10000 })
        return { success: true, message: `Unstaged ${files.length} file(s)` }
      } catch (err: unknown) {
        const stderr = (err as { stderr?: string })?.stderr?.trim()
        const msg = stderr || (err instanceof Error ? err.message : String(err))
        return { success: false, message: msg }
      }
    })

    ipcMain.handle('fb-git-discard', async (_event, projectCwd: string, files: string[]): Promise<GitOperationResult> => {
      const resolvedCwd = path.resolve(projectCwd)
      try {
        await execFileAsync('git', ['checkout', '--', ...files], { cwd: resolvedCwd, timeout: 10000 })
        return { success: true, message: `Discarded changes in ${files.length} file(s)` }
      } catch (err: unknown) {
        const stderr = (err as { stderr?: string })?.stderr?.trim()
        const msg = stderr || (err instanceof Error ? err.message : String(err))
        return { success: false, message: msg }
      }
    })

    ipcMain.handle('fb-git-pull', async (_event, projectCwd: string): Promise<GitOperationResult> => {
      const resolvedCwd = path.resolve(projectCwd)
      try {
        const { stdout, stderr } = await execFileAsync('git', ['pull'], { cwd: resolvedCwd, timeout: 60000 })
        return { success: true, message: stdout.trim() || stderr.trim() || 'Pull complete' }
      } catch (err: unknown) {
        const stderr = (err as { stderr?: string })?.stderr?.trim()
        const msg = stderr || (err instanceof Error ? err.message : String(err))
        return { success: false, message: msg }
      }
    })

    ipcMain.handle('fb-git-commit', async (_event, projectCwd: string, commitMessage: string): Promise<GitOperationResult> => {
      const resolvedCwd = path.resolve(projectCwd)
      if (!commitMessage || !commitMessage.trim()) {
        return { success: false, message: 'Commit message cannot be empty' }
      }
      try {
        const { stdout } = await execFileAsync('git', ['commit', '-m', commitMessage.trim()], { cwd: resolvedCwd, timeout: 30000 })
        return { success: true, message: stdout.trim() || 'Committed' }
      } catch (err: unknown) {
        const stderr = (err as { stderr?: string })?.stderr?.trim()
        const msg = stderr || (err instanceof Error ? err.message : String(err))
        return { success: false, message: msg }
      }
    })

    ipcMain.handle('fb-git-push', async (_event, projectCwd: string): Promise<GitOperationResult> => {
      const resolvedCwd = path.resolve(projectCwd)
      try {
        const { stdout, stderr } = await execFileAsync('git', ['push'], { cwd: resolvedCwd, timeout: 60000 })
        return { success: true, message: stdout.trim() || stderr.trim() || 'Push complete' }
      } catch (err: unknown) {
        const stderr = (err as { stderr?: string })?.stderr?.trim()
        const msg = stderr || (err instanceof Error ? err.message : String(err))
        return { success: false, message: msg }
      }
    })
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
      await execFileAsync('ssh', cleanupArgs, { timeout: 5000 })
    } catch {
      // Best-effort cleanup
    }
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
    // If the stored runtime's PTY has already exited and this tab is an SSH tab
    // whose project is currently connected, drop the dead runtime so we respawn
    // fresh.  Happens when a tab is hidden (renderer-side spawnedRef=false) while
    // SSH master dies and auto-reconnects: the renderer's false→true respawn
    // effect skips hidden tabs, so main is the only place left to detect and
    // clean up the stranded dead slave — otherwise the user sees a frozen
    // "Shared connection closed" in scrollback when they switch back to the tab.
    if (runtime && runtime.exitCode !== null && sshConfig && projectId
        && this.sshManager.getStatus(projectId) === 'connected') {
      this.logDebug(`ptyAttach refresh-dead id=${id} exitCode=${runtime.exitCode}`)
      this.ptyManager.kill(id)
      this.scrollbackStorage.delete(id)
      this.ptyRuntimes.delete(id)
      runtime = undefined
    }
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
    // A fresh process for this tab: whatever the old one was doing (including
    // 'exited') describes a process that no longer exists.
    this.activityRegistry.reset(id)

    // Capture the current runtime so callbacks can verify they belong to the
    // right generation.  After a kill+respawn cycle the same `id` maps to a
    // different runtime object — without this check the OLD process's delayed
    // onData/onExit would pollute the NEW runtime (setting exitCode, pushing
    // stale "Shared connection closed" output, etc.).
    const expectedRuntime = this.ptyRuntimes.get(id)

    const callbacks = {
      onData: (data: string) => {
        const runtime = this.ptyRuntimes.get(id)
        if (!runtime || runtime !== expectedRuntime) return
        runtime.scrollback = trimScrollback(runtime.scrollback + data)
        this.broadcastToAttachedWindows(id, 'pty-data', id, data)
        // Layer 3: a slave printing "Shared connection to <host> closed" means
        // the master's tunnel is dead — force an immediate reconnect instead
        // of waiting for the next health-check tick (up to 10s) and without
        // trusting `-O check` (which returns true when the master process is
        // alive but its TCP to the server has died).
        if (sshConfig && projectId && /Shared connection to \S+ closed/.test(data)) {
          this.sshManager.triggerReconnect(projectId, sshConfig)
        }
      },
      onExit: (exitCode: number) => {
        const runtime = this.ptyRuntimes.get(id)
        if (!runtime || runtime !== expectedRuntime) return
        runtime.exitCode = exitCode
        this.activityRegistry.exited(id)
        this.logDebug(`ptyExit id=${id} exitCode=${exitCode}`)
        this.broadcastToAttachedWindows(id, 'pty-exit', id, exitCode)
      }
    }

    if (sshConfig && projectId) {
      if (this.sshManager.getStatus(projectId) !== 'connected') {
        throw new Error('SSH connection not established')
      }

      const remoteCwd = cwd || sshConfig.remoteDir
      const isClaudeRemote = shell === 'claude' && extraEnv?.DEVTOOL_TAB_ID
      const isPiRemote = shell === AI_TAB_META.pi.command && extraEnv?.DEVTOOL_TAB_ID
      let hookInjectPrefix = ''
      let remoteArgs = args
      let remoteEnv = extraEnv
      if (isClaudeRemote) {
        const remotePort = this.sshManager.getRemotePort(projectId)
        if (remotePort) {
          this.hookInjector.remoteInject(projectId, remoteCwd, extraEnv.DEVTOOL_TAB_ID)
          hookInjectPrefix = this.hookInjector.buildRemoteInjectScript(remoteCwd, remotePort) + ' && '
          this.logDebug(`hookInjectRemote dir=${remoteCwd} port=${remotePort} tabId=${extraEnv?.DEVTOOL_TAB_ID}`)
        }
      } else if (isPiRemote) {
        // pi loads the status extension via `-e`; write it to the remote host and
        // point its callback at the reverse-tunnel port (reaches the local hook-server).
        const remotePort = this.sshManager.getRemotePort(projectId)
        if (remotePort) {
          const remoteExtPath = piExtensionRemotePath(sshConfig.username)
          hookInjectPrefix = buildRemotePiExtensionScript(remoteExtPath) + ' && '
          remoteArgs = [...(args ?? []), '-e', remoteExtPath]
          remoteEnv = { ...extraEnv, DEVTOOL_HOOK_PORT: String(remotePort) }
        }
      }

      const sshArgs = this.sshManager.buildSpawnArgs(projectId, sshConfig, shell, remoteArgs, remoteEnv, hookInjectPrefix, remoteCwd)
      this.ptyManager.spawn(id, 'ssh', os.tmpdir(), cols, rows, sshArgs, undefined, callbacks)
    } else {
      const isClaudeLocal = shell === 'claude' && extraEnv?.DEVTOOL_TAB_ID
      const isPiLocal = shell === AI_TAB_META.pi.command && extraEnv?.DEVTOOL_TAB_ID
      if (isClaudeLocal) {
        // Hooks land in the dir Claude is actually started in (a workspace task's
        // worktree, not the project root) — logged so a missing status is easy to
        // trace back to the settings file it should have been written to.
        this.hookInjector.inject(cwd, extraEnv.DEVTOOL_TAB_ID)
        this.logDebug(`hookInject dir=${cwd} tabId=${extraEnv?.DEVTOOL_TAB_ID}`)
      }
      let localArgs = args
      let localEnv = extraEnv
      if (isPiLocal) {
        localArgs = [...(args ?? []), '-e', piExtensionLocalPath()]
        localEnv = { ...extraEnv, DEVTOOL_HOOK_PORT: String(this.hookServer.getPort()) }
      }
      this.ptyManager.spawn(id, shell, cwd, cols, rows, localArgs, localEnv, callbacks)
    }
  }

  private killPty(id: string): void {
    this.logDebug(`ptyKill id=${id}`)
    const runtime = this.ptyRuntimes.get(id)
    if (runtime) {
      this.scrollbackStorage.save(id, runtime.scrollback)
    }
    this.ptyManager.kill(id)
    this.ptyRuntimes.delete(id)
    // No process, no activity: a status left at 'working' here would protect the
    // task from cleanup for the rest of the session.
    this.activityRegistry.remove(id)
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
    return this.projectsStore.peek().projects.find((project) => project.id === projectId)?.tunnel
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

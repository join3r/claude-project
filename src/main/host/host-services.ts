import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { Storage } from '../storage'
import { ScrollbackStorage } from '../scrollback-storage'
import { ArchiveStorage } from '../archive-storage'
import { PtyManager } from '../pty-manager'
import { PtySessions } from '../pty-sessions'
import { HookServer } from '../hook-server'
import { HookInjector, hookEndpointFor } from '../hook-injector'
import { ClaudeChatManager } from '../claude-chat/chat-manager'
import { SshConnectionManager } from '../ssh-connection-manager'
import { CodexSessionManager } from '../codex-session-manager'
import { RemoteWorkspaceManager } from '../remote-workspace-manager'
import { WorkspaceManager } from '../workspace-manager'
import { FileSetupApprovals } from '../worktree-setup-approvals'
import { TaskWorktreeManager } from '../task-worktree'
import { recordSetupArtifacts, TaskLandingManager } from '../task-landing'
import { LocalGitRunner } from '../git-runner'
import { bracketedPaste } from '../pty-paste'
import { NotesStorage } from '../notes-storage'
import { RevisionStore } from '../revision-store'
import { TabActivityRegistry } from '../tab-activity-registry'
import { KeyInterrupts } from '../key-interrupts'
import { TerminalStatusTracker } from '../terminal-status-tracker'
import { SleepBlocker } from '../sleep-blocker'
import type { ActivityUpdate } from '../../shared/agent-activity'
import { tearDownTabs, tearDownTaskTabs, type TaskTeardownTargets } from '../task-teardown'
import { PaletteFrecencyStorage } from '../palette-frecency-storage'
import { agentCommandOverride, resolveAgentCommand } from '../resolve-agent-command'
import { findGitBashExe, getShellEnv, resolveShellEnv, setPortableNodeDir } from '../shell-env'
import { PI_EXTENSION_RESOURCE } from '../pi-extension-injector'
import type { IpcRegistrar } from '../ipc/registrar'
import { allowedLocalRoots, resolveAllowedDirectory } from '../ipc/path-allowlist'
import { registerAppStateHandlers } from '../ipc/app-state'
import { registerSshHandlers } from '../ipc/ssh'
import { registerAgentHandlers } from '../ipc/agents'
import { registerTerminalHandlers } from '../ipc/terminals'
import { createWorkspace, listWorkspaceBranches, registerWorkspaceHandlers } from '../ipc/workspaces'
import { registerArchiveHandlers } from '../ipc/archive'
import { readLocalTranscript, readRemoteTranscript } from '../claude-chat/transcript'
import { readPermissionSettings, updatePermissionRule } from '../claude-chat/permission-settings'
import { registerFileBrowserHandlers } from '../ipc/file-browser'
import { registerGitHandlers } from '../ipc/git'
import { registerNotebookHandlers } from '../ipc/notebooks'
import { registerHostFsHandlers } from '../ipc/host-fs'
import { registerHostAgentHandlers } from '../ipc/host-agents'
import { registerHostSshHandlers } from '../ipc/host-ssh'
import { detectAgentClis } from '../agent-clis'
import { isRemoteProject, isShellCommandProject } from '../../shared/types'
import { archiveTasksInData, archivedTabIds, archivedTaskEntry, vanishedProjectIds, withArchivedTasks, type ProjectArchive } from '../../shared/archive'
import {
  NOTEBOOK_ERROR_REMOTE,
  NOTEBOOK_ERROR_SHELL_PROJECT,
  resolveNotebookKernelCondaEnv,
  type NotebookKernelCondaOverride
} from '../../shared/notebook'
import { notebookAllowedCwdRoots, resolveNotebookKernelCwd } from '../notebook-cwd'
import { listCondaEnvs, listCondaEnvsForNotebookKernel, resolveProjectCondaEnv } from '../conda-env'
import { NOTEBOOK_KERNEL_HELPER_RESOURCE, NotebookKernelManager } from '../notebook-kernel'
import type { CondaEnvInfo } from '../../shared/conda'
import { registerHostMobileHandlers, registerMobileHandlers } from '../ipc/mobile'
import { registerTaskWorktreeHandlers } from '../ipc/task-worktrees'
import { registerTaskLandingHandlers } from '../ipc/task-landing'
import { registerPromptQueueHandlers } from '../ipc/prompt-queue'
import { PromptQueueRunner } from '../prompt-queue-runner'
import { featureUnavailableReason } from '../../shared/project-features'
import { findTaskInProject, removeTaskFromProject, taskTabs } from '../../shared/streams'
import { chatTabConfig } from '../../shared/chat-tab-config'
import { MobileService } from '../mobile/mobile-service'
import { PairingsStore } from '../mobile/pairings-store'
import { IdentityStore } from '../mobile/identity'
import { createInvite } from '../mobile/invite'
import { RelayClient } from '../mobile/relay-client'
import { RelayMux } from './link/relay-mux'
import { createNoiseChannelFactory } from '../mobile/channel'
import { ChatBridge } from '../mobile/chat-bridge'
import { PushEmitter } from '../mobile/push-emitter'
import { createStream, listProjectBranches, type StreamGit } from '../mobile/new-stream'
import { addTaskWithChat } from '../mobile/new-task'
import { closeTask, findClosableTab, landTask, removeTabFromData } from '../mobile/close-task'
import { setPinInData } from '../mobile/pin'
import { triageTaskInData } from '../mobile/triage'
import {
  AppErrorCode,
  BRANCHES_LIST_FEATURE,
  CHAT_COMMANDS_FEATURE,
  CHAT_IMAGE_FEATURE,
  SEND_IMAGES_FEATURE,
  CHAT_SETTINGS_FEATURE,
  PIN_FEATURE,
  STREAM_NEW_FEATURE,
  TAB_CLOSE_FEATURE,
  TASK_CLOSE_FEATURE,
  TASK_LAND_FEATURE,
  TASK_NEW_FEATURE,
  TASK_TRIAGE_FEATURE,
  SERVER_APP_NAME
} from '../../../protocol/ts/index.ts'
import { normalizeMobileConfig, normalizeRelayUrl, type MobileConfig } from '../../shared/mobile'
import { SERVER_MOBILE_STATE_CHANNEL } from '../../shared/servers'
import { LOCAL_SOURCE } from '../../shared/projects-sources'
import type {
  AppConfig,
  Project,
  ProjectsData,
  SshConfig,
  Tab,
  Task,
  TunnelConfig,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResult,
  NotesRecord,
  HostTabStatus,
  TabStatusValue
} from '../../shared/types'
import type { ClientHub } from './client-hub'
import type { HostEnv } from './host-env'

const execFileAsync = promisify(execFile)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export interface HostServicesOptions {
  env: HostEnv
  clients: ClientHub
  /**
   * Who this host is on the relay: a desktop, or a DevTool server (SPEC.md §3.8).
   * Phones and the host link share that one socket and identity.
   */
  relayRole?: 'desktop' | 'server'
  /**
   * Main archived a task on its own (a phone's close, a landing): the desktop
   * drops it from the window view states it persists.
   */
  onTaskArchived?: (taskId: string) => void
  /** How this host's projects.json is kept (see `ProjectsNormalizeOptions`). */
  projects?: {
    /** A desktop's server projects: its local order and pins may name them. */
    foreign?: () => readonly Project[]
    /** A server keeps tag ids only its desktops know. */
    keepUnknownTagIds?: boolean
    /** The first revision (a server starts from the clock; see RevisionStore). */
    initialRevision?: number
  }
  /**
   * Who works out the status of tabs without hooks (shells, Codex): the windows
   * showing them (a desktop, `report-tab-status`), or the host itself from their
   * PTY output (a server, so it has statuses with no window attached).
   */
  terminalStatus?: 'windows' | 'host'
  /**
   * This host's clients are all on other machines (a DevTool server): a chat's
   * `/login` can't finish in a browser here, so it asks for the pasted code.
   */
  remoteClients?: boolean
  /**
   * A DevTool server's phones (plan step 10): the relay they reach it on and the
   * name they see come from the server's own `server.json`, not the Mobile
   * setting. With `relayRole: 'server'` its handshake says `devtool-server/<version>`
   * (SPEC.md §4.3), its phone state goes to its desktops on
   * `server-mobile-state-changed`, and a phone's `task.new` needs no Claude switch.
   */
  phones?: {
    relayUrl: () => string
    name: () => string
  }
}

/**
 * The host side of main: projects and notes, terminals, agents and chats, hooks,
 * SSH, worktrees and landing, notebooks and phones, and the IPC handlers in front
 * of them. Windows are reached only through the {@link ClientHub} and the process
 * only through the {@link HostEnv}, so this runs without Electron.
 */
export class HostServices {
  readonly storage: Storage
  private readonly scrollbackStorage: ScrollbackStorage
  private readonly archiveStorage: ArchiveStorage
  private readonly notesStorage: NotesStorage
  private readonly paletteFrecencyStorage: PaletteFrecencyStorage
  private readonly ptyManager = new PtyManager()
  /** Native notebook tabs' Jupyter kernels, one per tab. */
  private readonly notebookKernels: NotebookKernelManager
  /** tabId -> token of a kernel start still awaiting its conda lookup. */
  private readonly pendingNotebookStarts = new Map<string, number>()
  private notebookStartCounter = 0
  private readonly hookServer = new HookServer((message) => this.logDebug(message))
  private readonly codexSessionManager = new CodexSessionManager()
  private readonly workspaceManager: WorkspaceManager
  private readonly remoteWorkspaceManager = new RemoteWorkspaceManager()
  private readonly ptySessions: PtySessions
  /** Esc in a Claude terminal tab, standing in for the Stop the CLI skips. */
  private readonly keyInterrupts = new KeyInterrupts()
  /** Main's authoritative view of what every tab's agent is doing. */
  private readonly activityRegistry = new TabActivityRegistry()
  private readonly sleepBlocker: SleepBlocker
  /** Tabs with an unsaved editor buffer, per client — a task holding one is not swept. */
  private readonly dirtyTabsByClient = new Map<string, Set<string>>()
  /** Which client last reported each hook-less tab's status (`report-tab-status`). */
  private readonly statusReporters = new Map<string, string>()
  /** The last status `tab-host-status` sent per tab. */
  private readonly sentTabStatuses = new Map<string, TabStatusValue>()
  private hookInjector!: HookInjector
  sshManager!: SshConnectionManager
  /** Claude chat tabs' processes — the Agent SDK counterpart of `ptySessions`. */
  private chatManager!: ClaudeChatManager
  /** Phones: relay connection, pairing and the inbox they see. Dormant while Mobile is off. */
  private mobileService!: MobileService
  /**
   * This host's keys (`<configDir>/mobile/identity.json`), for phones and the host
   * link alike. Loaded on first use: on macOS safeStorage can raise a Keychain prompt.
   */
  readonly identity: IdentityStore
  /** The one relay socket, shared by the phones and the host link (servers or desktops). */
  readonly relay: RelayMux
  private readonly relayClient: RelayClient
  private readonly configListeners = new Set<(config: AppConfig) => void>()
  private started = false
  private readonly projectsStore: RevisionStore<ProjectsData>
  /** Tasks' own worktrees, made just before their first spawn. */
  private readonly taskWorktrees: TaskWorktreeManager
  /** Tasks' worktrees landing back into their streams. */
  private readonly taskLanding: TaskLandingManager
  private readonly promptQueue: PromptQueueRunner
  private readonly notesStore: RevisionStore<NotesRecord>
  private config: AppConfig
  private readonly env: HostEnv
  private readonly clients: ClientHub
  private readonly onTaskArchived: (taskId: string) => void
  private readonly remoteClients: boolean
  /** A DevTool server's host (relay role `server`), not a desktop's own. */
  private readonly isServer: boolean
  private readonly phones: HostServicesOptions['phones']

  constructor({ env, clients, onTaskArchived, relayRole, projects, terminalStatus, remoteClients, phones }: HostServicesOptions) {
    this.env = env
    this.clients = clients
    this.remoteClients = remoteClients === true
    this.isServer = relayRole === 'server'
    this.phones = phones
    this.onTaskArchived = onTaskArchived ?? (() => {})
    const configDir = env.configDir
    const identity = new IdentityStore(path.join(configDir, 'mobile'), env.secrets, (message) => this.logDebug(message))
    this.identity = identity
    this.relayClient = new RelayClient({
      role: relayRole ?? 'desktop',
      // Servers need binary frames; phones keep getting JSON from the relay.
      binary: true,
      ed25519: () => identity.get().ed25519,
      deviceId: () => identity.get().id,
      log: (message) => this.logDebug(`relay ${message}`)
    })
    this.relay = new RelayMux(this.relayClient, (message) => this.logDebug(message))
    this.storage = new Storage(configDir, {
      projectsNormalize: () => ({
        foreignProjects: projects?.foreign?.() ?? [],
        keepUnknownTagIds: projects?.keepUnknownTagIds
      })
    })
    this.scrollbackStorage = new ScrollbackStorage(path.join(configDir, 'scrollback'))
    this.archiveStorage = new ArchiveStorage(path.join(configDir, 'archive'))
    this.notesStorage = new NotesStorage(configDir)
    this.paletteFrecencyStorage = new PaletteFrecencyStorage(configDir)
    this.notebookKernels = new NotebookKernelManager({ helperPath: env.resourcePath(NOTEBOOK_KERNEL_HELPER_RESOURCE) })
    this.workspaceManager = new WorkspaceManager({ approvals: new FileSetupApprovals(configDir) })

    this.storage.backupProjectsOnStartup()
    this.projectsStore = new RevisionStore<ProjectsData>({
      initial: this.storage.loadProjects(),
      normalize: (data) => this.storage.normalizeProjects(data),
      persist: (data) => this.storage.saveProjects(data),
      broadcast: (envelope) => this.clients.broadcast('projects-updated', { source: LOCAL_SOURCE, ...envelope }),
      initialRevision: projects?.initialRevision
    })
    // Notes only gained a canonical copy in main when they gained a revision: before
    // that `notes-save` proxied straight to disk, which is why note changes never
    // reached the other windows at all.
    this.notesStore = new RevisionStore<NotesRecord>({
      initial: this.notesStorage.load(),
      persist: (data) => this.notesStorage.save(data),
      broadcast: (envelope) => this.clients.broadcast('notes-updated', envelope)
    })
    const gitRunner = new LocalGitRunner()
    this.taskWorktrees = new TaskWorktreeManager({
      projects: {
        peek: () => this.projectsStore.peek(),
        commit: (data) => { this.commitProjects(data) },
        subscribe: (listener) => this.projectsStore.subscribe(() => listener())
      },
      git: this.workspaceManager,
      onState: (taskId, state) => this.clients.broadcast('task-worktree-state', taskId, state),
      log: (message) => this.logDebug(message),
      recordSetupArtifacts: (worktreeRoot) => recordSetupArtifacts(gitRunner, worktreeRoot),
      // Made just below; only asked once something calls ensure.
      isLanding: (taskId) => this.taskLanding.isBusy(taskId)
    })
    this.taskLanding = new TaskLandingManager({
      projects: {
        peek: () => this.projectsStore.peek(),
        commit: (data) => { this.commitProjects(data) }
      },
      runner: gitRunner,
      git: this.workspaceManager,
      activity: this.activityRegistry,
      sendToAgent: (project, task, tab, text) => this.sendToAgentTab(project, task, tab, text),
      forgetWorktree: (taskId) => this.taskWorktrees.forget(taskId),
      stopTabs: (project, task) => this.stopTaskTabs(project, task),
      // Every close a landing finishes is archived here, whoever asked for it (a
      // window, a phone, the agent that fixed a conflict).
      archiveTask: async (projectId, taskId, closed, dir) => {
        const project = this.projectsStore.peek().projects.find(p => p.id === projectId)
        const task = findTaskInProject(project, taskId)
        if (project && task) await this.archiveTaskFromMain(project, task, { task: closed, dir })
      },
      onState: (taskId, landing) => this.clients.broadcast('task-landing-state', taskId, landing),
      log: (message) => this.logDebug(message)
    })
    this.promptQueue = new PromptQueueRunner({
      peek: () => this.projectsStore.peek(),
      commit: (data) => { this.commitProjects(data) },
      subscribeProjects: (listener) => this.projectsStore.subscribe(() => listener()),
      statusOf: (tabId) => this.activityRegistry.getStatus(tabId),
      subscribe: (listener) => this.activityRegistry.subscribe(listener),
      blocker: (project) => {
        if (isShellCommandProject(project)) return 'A shell-command project runs one command, not Claude.'
        // A server has no Claude switch: its desktops' settings are theirs.
        if (!this.isServer && !this.config.enableClaude) return 'Claude is turned off in Settings.'
        return featureUnavailableReason(project, 'chat')
      },
      ensureWorktree: async (projectId, taskId) => {
        const result = await this.taskWorktrees.ensureTaskWorktree(projectId, taskId)
        return result.status === 'failed' ? { ok: false, error: result.error } : { ok: true }
      },
      sendFirstPrompt: async (projectId, taskId, tabId, prompt) => {
        const project = this.projectsStore.peek().projects.find(p => p.id === projectId)
        const task = findTaskInProject(project, taskId)
        const tab = task ? taskTabs(task).find(t => t.id === tabId) : undefined
        if (!project || !task || !tab) throw new Error('The task is gone')
        // The permission mode the New task composer last used, as a window's first prompt carries it.
        const mode = this.config.promptBoxMode
        if (mode && tab.sessionId) {
          if (!this.chatManager.snapshot(tab.id)) {
            const { stop } = await this.chatManager.listen(tab.id, chatTabConfig(project, task, tab.sessionId), () => {})
            stop()
          }
          await this.chatManager.setPermissionMode(tab.id, mode)
        }
        await this.sendToAgentTab(project, task, tab, prompt)
      },
      log: (message) => this.logDebug(message)
    })
    this.forgetArchivesOfVanishedProjects()
    this.config = this.storage.loadConfig()
    setPortableNodeDir(this.config.portableNodeDir)
    this.sleepBlocker = new SleepBlocker(
      env.powerSave,
      () => this.activityRegistry.getSnapshot(),
      () => this.config.keepAwakeWhileWorking !== false,
      (message) => this.logDebug(message)
    )
    this.activityRegistry.subscribe(() => this.sleepBlocker.update())
    this.activityRegistry.subscribe((tabId) => this.broadcastTabStatus(tabId))
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
      sendToClient: (clientId, channel, ...args) => this.clients.send(clientId, channel, ...args),
      log: (message) => this.logDebug(message),
      piExtensionPath: () => env.resourcePath(PI_EXTENSION_RESOURCE),
      condaEnvForProject: (projectId) => this.condaEnvForLocalProject(projectId),
      onKill: (tabId) => this.shutdownNotebookKernel(tabId),
      onInterruptKey: (tabId) => {
        this.keyInterrupts.pressed(tabId, this.activityRegistry.getStatus(tabId), () => {
          this.logDebug(`interruptKey tab=${tabId}`)
          this.handleHook('stopped', tabId, { hook_event_name: 'Stop' })
        })
      },
      terminalStatus: terminalStatus === 'host' ? this.hostTerminalStatus() : undefined
    })
  }

  /** The terminal status heuristics run here, feeding the activity registry like a window's reports. */
  private hostTerminalStatus(): { output: (tabId: string, data: string) => void; forget: (tabId: string) => void } {
    const tracker = new TerminalStatusTracker({
      getStatus: (tabId) => this.activityRegistry.getStatus(tabId),
      report: (tabId, status) => this.activityRegistry.reported(tabId, status)
    })
    return {
      output: (tabId, data) => tracker.output(tabId, data),
      forget: (tabId) => tracker.forget(tabId)
    }
  }

  /**
   * The one write path for canonical projects state from inside main (a phone's
   * and anything after it). Going through here is what bumps the revision and tells
   * the windows, so a main-side deletion cannot be resurrected by a stale renderer.
   */
  commitProjects(next: ProjectsData): ProjectsData {
    return this.projectsStore.commit(next).data
  }

  getProjectsData(): ProjectsData {
    return this.projectsStore.peek()
  }

  /** After every commit of this host's projects (a desktop's router re-indexes them). */
  onProjectsChanged(listener: (data: ProjectsData) => void): () => void {
    return this.projectsStore.subscribe(listener)
  }

  getConfig(): AppConfig {
    return this.config
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.hookServer.start()
    this.logDebug(`start hookPort=${this.hookServer.getPort()}`)
    this.hookInjector = new HookInjector(this.hookServer.getPort(), this.hookServer.getToken())
    this.sshManager = new SshConnectionManager(path.join(this.env.configDir, 'ssh'), this.hookServer.getPort())
    this.notebookKernels.onEvent((tabId, event) => {
      this.clients.broadcast('notebook-kernel-event', tabId, event)
    })
    this.chatManager = this.createChatManager()
    this.mobileService = this.createMobileService()
    this.registerEventForwarders()
    void this.taskLanding.reconcile()
    this.promptQueue.start()
    this.mobileService.start()
  }

  private createMobileService(): MobileService {
    const mobileDir = path.join(this.env.configDir, 'mobile')
    const log = (message: string) => this.logDebug(message)
    // Loaded on first use (Mobile on, or a pairing started), never at startup:
    // safeStorage can raise a Keychain prompt on macOS.
    const identity = this.identity
    const hostName = () => this.phones?.name() || os.hostname().replace(/\.local$/, '')
    const desktopName = () => this.mobileConfig().desktopName?.trim() || hostName()
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
      onPhoneSend: (phoneId, tabId) => push.phoneSent(phoneId, tabId),
      worktrees: { ensure: (projectId, taskId) => this.taskWorktrees.ensureTaskWorktree(projectId, taskId) },
      images: this.env.images,
      // The same folder check as the chat tab's /permissions IPC.
      permissions: {
        read: async (cwd) => readPermissionSettings(await this.resolveAllowedDirectory(cwd)),
        update: async (cwd, kind, behavior, rule, action) =>
          updatePermissionRule(await this.resolveAllowedDirectory(cwd), kind, behavior, rule, action)
      }
    })
    push.start()
    service = new MobileService({
      getConfig: () => this.mobileConfig(),
      saveConfig: (mobile) => this.applyConfig({ mobile }),
      projects: {
        peek: () => this.projectsStore.peek(),
        subscribe: (listener) => this.projectsStore.subscribe(() => listener())
      },
      activity: this.activityRegistry,
      pairings: new PairingsStore(mobileDir, log),
      getDesktopId: () => identity.peekId(),
      defaultDesktopName: hostName,
      createTransport: () => this.relay.mobileTransport(),
      channels: createNoiseChannelFactory({
        staticKey: () => identity.get().x25519,
        // A phone shows a server as one (SPEC.md §4.3).
        app: `${this.isServer ? SERVER_APP_NAME : 'devtool'}/${this.env.appVersion}`,
        desktopName,
        features: () => [TASK_NEW_FEATURE, CHAT_SETTINGS_FEATURE, TASK_CLOSE_FEATURE, TAB_CLOSE_FEATURE, CHAT_IMAGE_FEATURE, PIN_FEATURE, TASK_TRIAGE_FEATURE, STREAM_NEW_FEATURE, BRANCHES_LIST_FEATURE, CHAT_COMMANDS_FEATURE, TASK_LAND_FEATURE, SEND_IMAGES_FEATURE],
        log
      }),
      createInvite: (options) => createInvite(identity.get(), options),
      // A server's own state is not a desktop's Settings › Mobile: its desktops show it under Servers.
      broadcastState: (state) => this.clients.broadcast(this.isServer ? SERVER_MOBILE_STATE_CHANNEL : 'mobile-state-changed', state),
      log,
      chat: bridge,
      newTask: async (phoneId, { projectId, streamId, prompt, mode, images }) => {
        // A server has no Claude switch: its desktops' settings are theirs.
        if (!this.isServer && !this.config.enableClaude) {
          return { ok: false, code: AppErrorCode.Unsupported, message: 'Claude is turned off on this desktop' }
        }
        const added = addTaskWithChat(this.projectsStore.peek(), projectId, prompt, streamId)
        if (!added.ok) return added
        this.commitProjects(added.data)
        // In a worktree stream the chat starts in the task's own worktree. Setup
        // commands awaiting approval don't hold it up: that question is the desktop's.
        const worktree = await this.taskWorktrees.ensureTaskWorktree(projectId, added.taskId)
        if (worktree.status === 'failed') {
          // Nothing ran in it yet and the phone gets the error, so the task goes again.
          const data = this.projectsStore.peek()
          this.commitProjects({
            ...data,
            projects: data.projects.map(p => (p.id === projectId ? removeTaskFromProject(p, added.taskId) : p))
          })
          return { ok: false, code: AppErrorCode.Internal, message: `Couldn't create the task's worktree: ${worktree.error}` }
        }
        // The task exists from here on, so a failed start is logged rather than
        // reported: the phone opens the chat either way and sees its state there,
        // where a retry of task.new would only make a second task.
        try {
          await bridge.startTask(phoneId, added.tabId, prompt, mode, images)
        } catch (err) {
          log(`task.new start tab=${added.tabId} error=${err instanceof Error ? err.message : String(err)}`)
        }
        return { ok: true, taskId: added.taskId, tabId: added.tabId }
      },
      closeTask: (params, phone) => closeTask({
        peek: () => this.projectsStore.peek(),
        dirtyTabIds: () => this.getDirtyTabIds(),
        statusOf: (tabId) => this.activityRegistry.getStatus(tabId),
        removeTask: (project, task) => this.archiveTaskFromMain(project, task),
        // A task with its own worktree lands, as the sidebar's Close does.
        landing: this.taskLanding,
        stopTabs: (project, task) => this.stopTaskTabs(project, task)
      }, params, phone),
      landTask: (params) => landTask({ peek: () => this.projectsStore.peek(), landing: this.taskLanding }, params),
      closeTab: async (tabId) => {
        const found = findClosableTab(this.projectsStore.peek(), tabId)
        if (!found) return { ok: false, code: AppErrorCode.NotFound, message: 'No such tab. A task\'s own agent or terminal closes with the task.' }
        await this.removeTabFromMain(found.project, found.task, found.tab)
        return { ok: true }
      },
      setPin: (params) => {
        const outcome = setPinInData(this.projectsStore.peek(), params)
        if (!outcome.ok) return outcome
        if (outcome.changed) this.commitProjects(outcome.data)
        return { ok: true }
      },
      triageTask: (params) => {
        const outcome = triageTaskInData(this.projectsStore.peek(), params, Date.now())
        if (!outcome.ok) return outcome
        if (outcome.changed) this.commitProjects(outcome.data)
        return { ok: true }
      },
      newStream: (params) => createStream({
        ...this.streamGit(),
        peek: () => this.projectsStore.peek(),
        commit: (data) => this.commitProjects(data)
      }, params),
      listBranches: (projectId) => listProjectBranches({
        ...this.streamGit(),
        peek: () => this.projectsStore.peek()
      }, projectId)
    })
    return service
  }

  /** The Mobile setting; a server's phones take the relay and name from its own settings. */
  private mobileConfig(): MobileConfig {
    const config = normalizeMobileConfig(this.config.mobile)
    if (!this.phones) return config
    const name = this.phones.name()
    return { ...config, relayUrl: normalizeRelayUrl(this.phones.relayUrl()), ...(name ? { desktopName: name } : {}) }
  }

  /** This host's phones: pairing, Accept and Reject, the paired list (a server's CLI and its desktops drive it). */
  get mobile(): MobileService {
    return this.mobileService
  }

  /**
   * Unpairs every phone (a server deleting its data takes its identity with it,
   * so the relay's pairs would be useless). Answers how many there were.
   */
  revokeAllPhones(): number {
    const phones = this.mobileService.getState().devices
    for (const phone of phones) {
      try {
        this.mobileService.revoke(phone.id)
      } catch (err) {
        this.logDebug(`revokeAllPhones phone=${phone.id} error=${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return phones.length
  }

  /**
   * A client went away (a window closed). Its unsaved buffers went with it;
   * leaving them behind would block a phone's close of their tasks forever.
   */
  detachClient(clientId: string): void {
    this.dirtyTabsByClient.delete(clientId)
    for (const [tabId, reporter] of this.statusReporters) {
      if (reporter !== clientId) continue
      this.statusReporters.delete(tabId)
      this.activityRegistry.unreported(tabId)
    }
    this.chatManager.detachClient(clientId)
    this.ptySessions.detachClient(clientId)
  }

  private getDirtyTabIds(): string[] {
    const ids = new Set<string>()
    for (const tabIds of this.dirtyTabsByClient.values()) {
      for (const tabId of tabIds) ids.add(tabId)
    }
    return [...ids]
  }

  /**
   * Archive a task on main's own behalf (a phone's `task.close`), doing here every
   * piece of teardown a window does when it closes one — the PTYs (which outlive a
   * hidden tab), the hook injections and the activity entries. The scrollback
   * stays, for Reopen. A renderer only tears down tabs it has mounted, so nothing
   * here may be left to the broadcast; the broadcast covers only what is
   * renderer-local (xterm instances, per-window status entries, view state).
   * A landing's close passes `closed`: the task as it left its worktree, and
   * the directory its sessions ran in.
   */
  private async archiveTaskFromMain(project: Project, task: Task, closed?: { task: Task; dir: string }): Promise<void> {
    const found = archivedTaskEntry(project, task.id, Date.now())
    const entry = found && closed ? { ...found, task: closed.task, dir: closed.dir } : found
    const tabIds = await tearDownTaskTabs(project, task, { ...this.teardownTargets(), deleteScrollback: () => {} })

    // Sent before the state commit, and on the same ordered channel: a window that
    // learns the task is gone first unmounts its tabs, and the components that own
    // the xterm instances and status entries would no longer be listening.
    this.clients.broadcast('tasks-removed', { projectId: project.id, taskId: task.id, tabIds })

    // The file first, then the data: a crash in between leaves the task in both
    // (the archive view hides it), never in neither.
    const data = this.projectsStore.peek()
    const next = archiveTasksInData(data, project.id, [task.id])
    const retired = !next.projects.some(candidate => candidate.id === project.id)
    if (entry && !retired) {
      this.archiveStorage.update(project.id, archive => withArchivedTasks(archive, [entry]))
      this.clients.broadcast('archive-changed', project.id)
    }
    this.commitProjects(next)

    this.onTaskArchived(task.id)
  }

  /**
   * A project that leaves the data (deleted, or a spent hidden one swept away)
   * takes its archive with it, and the scrollback of the archived tabs: its Done
   * rows are unreachable from then on.
   */
  private forgetArchivesOfVanishedProjects(): void {
    let before = this.projectsStore.peek().projects
    this.projectsStore.subscribe((data) => {
      const gone = vanishedProjectIds(before, data.projects)
      before = data.projects
      for (const projectId of gone) {
        try {
          for (const tabId of archivedTabIds(this.archiveStorage.load(projectId))) this.scrollbackStorage.delete(tabId)
          this.archiveStorage.delete(projectId)
        } catch (err) {
          this.logDebug(`archiveForget projectId=${projectId} error=${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })
  }

  /**
   * End a task's processes before its worktree is removed (a landing's close):
   * the teardown archiving does, keeping the scrollback. Windows can't delete a
   * folder a process still runs in, so there they get a moment to exit.
   */
  private async stopTaskTabs(project: Project, task: Task): Promise<void> {
    const tabIds = await tearDownTaskTabs(project, task, { ...this.teardownTargets(), deleteScrollback: () => {} })
    if (process.platform === 'win32' && tabIds.length > 0) await new Promise(resolve => setTimeout(resolve, 500))
  }

  /** A project's archive on this host (Move to a DevTool server copies it to the server's). */
  archiveOf(projectId: string): ProjectArchive {
    return this.archiveStorage.load(projectId)
  }

  /** Of these tabs, the ones whose process (a PTY or a chat) runs here. */
  liveTabs(tabIds: readonly string[]): string[] {
    const live = new Set([...this.ptySessions.liveTabIds(), ...this.chatManager.liveTabIds()])
    return tabIds.filter(tabId => live.has(tabId))
  }

  /**
   * An SSH project leaves for a DevTool server: every tab's process ends here
   * without a word to the windows (they dropped their copies already), its
   * scrollback and activity go, and Claude's hooks leave the remote settings
   * while the project's SSH connection is still up. The server injects its own.
   */
  async endProjectTabs(project: Project): Promise<void> {
    const targets = this.teardownTargets()
    for (const stream of project.streams) {
      for (const task of stream.tasks) await tearDownTaskTabs(project, task, targets)
    }
    const ssh = project.ssh
    if (!ssh) return
    // Injections a tab's directory no longer names (it moved, or the dir was computed differently).
    for (const dir of this.hookInjector.remoteReleaseAll(project.id)) {
      if (this.sshManager.getStatus(project.id) !== 'connected') break
      try {
        await execFileAsync(this.sshManager.getSshCommand(), [
          '-S', this.sshManager.getSocketPath(project.id),
          `${ssh.username}@${ssh.host}`,
          this.hookInjector.buildRemoteCleanupScript(dir)
        ], { timeout: 5000 })
      } catch {
        // Best effort, as for one tab: the server's own injection replaces stale hooks.
      }
    }
  }

  /** What a window does for the tabs it closes, done by main for tabs no window may be showing. */
  private teardownTargets(): TaskTeardownTargets {
    return {
      killPty: (tabId) => {
        this.ptySessions.discard(tabId)
        this.chatManager.close(tabId)
      },
      deleteScrollback: (tabId) => this.scrollbackStorage.delete(tabId),
      forgetActivity: (tabId) => {
        this.statusReporters.delete(tabId)
        this.keyInterrupts.forget(tabId)
        this.activityRegistry.remove(tabId)
        this.broadcastAgentActivity(tabId)
      },
      releaseHooks: (owner, dir, tabId) => owner.ssh
        ? this.cleanupRemoteHooks(owner.id, owner.ssh, dir, tabId)
        : this.hookInjector.cleanup(dir, tabId)
    }
  }

  /**
   * Close one tab on main's own behalf (the phone's `tab.close`): the same teardown
   * as {@link archiveTaskFromMain}, for one tab (a closed tab's scrollback goes), with the task left in place.
   */
  private async removeTabFromMain(project: Project, task: Task, tab: Tab): Promise<void> {
    const tabIds = await tearDownTabs(project, task, [tab], this.teardownTargets())
    // Before the commit, for the same reason as `tasks-removed`.
    this.clients.broadcast('tabs-removed', { projectId: project.id, taskId: task.id, tabIds })
    this.commitProjects(removeTabFromData(this.projectsStore.peek(), task.id, tab.id))
  }

  /**
   * Type a prompt into an agent tab and submit it, from main (a landing's
   * "Ask agent to fix"): a chat tab gets its runtime started if no window has
   * it; a terminal agent gets it pasted (bracketed, as a window's link insert
   * does, control characters replaced) and Enter a beat later. A terminal agent must be running already.
   */
  private async sendToAgentTab(project: Project, task: Task, tab: Tab, text: string): Promise<void> {
    if (tab.type === 'claude-chat') {
      if (!tab.sessionId) throw new Error('Open the task\'s chat once, then ask again')
      if (!this.chatManager.snapshot(tab.id)) {
        const { stop } = await this.chatManager.listen(tab.id, chatTabConfig(project, task, tab.sessionId), () => {})
        stop()
      }
      await this.chatManager.send(tab.id, text)
      return
    }
    if (!this.ptySessions.writeFromMain(tab.id, bracketedPaste(text))) {
      throw new Error('The task\'s agent is not running. Open the task, then ask again.')
    }
    setTimeout(() => this.ptySessions.writeFromMain(tab.id, '\r'), 150)
  }

  /** Run a shell script on a remote project's host over its control socket; resolves its stdout. */
  private async remoteExec(projectId: string, sshConfig: SshConfig, script: string): Promise<string> {
    const { stdout } = await execFileAsync(this.sshManager.getSshCommand(), [
      '-S', this.sshManager.getSocketPath(projectId),
      `${sshConfig.username}@${sshConfig.host}`,
      script
    ], { timeout: 30_000, maxBuffer: 512 * 1024 * 1024 })
    return stdout
  }

  /** Runs after every config change (the desktop's server hub follows the relay URL). */
  /** No tab is working: a server may restart into an update without cutting a turn short. */
  isIdle(): boolean {
    return !Object.values(this.activityRegistry.getSnapshot()).some((status) => status === 'working')
  }

  /** Any tab's activity changed (status, since or activity). */
  onActivityChange(listener: () => void): () => void {
    return this.activityRegistry.subscribe(() => listener())
  }

  onConfigChanged(listener: (config: AppConfig) => void): () => void {
    this.configListeners.add(listener)
    return () => { this.configListeners.delete(listener) }
  }

  /**
   * Flow control for a congested host link: hold a terminal tab's output back
   * (the PTY stops being read) until `holder` releases it. False for no live tab.
   */
  holdTerminalOutput(tabId: string, holder: string): boolean {
    return this.ptySessions.holdOutput(tabId, holder)
  }

  releaseTerminalOutput(tabId: string, holder: string): void {
    this.ptySessions.releaseOutput(tabId, holder)
  }

  terminalOutputHeldBy(holder: string): string[] {
    return this.ptySessions.heldBy(holder)
  }

  /** Every tab's status as this host has it (hooks, reports, or its own terminal heuristics). */
  tabStatuses(): Record<string, TabStatusValue> {
    return this.activityRegistry.getSnapshot()
  }

  async shutdown(): Promise<void> {
    this.mobileService?.stop()
    this.promptQueue.dispose()
    this.ptySessions.saveAllScrollback()
    this.ptySessions.killAll()
    this.notebookKernels.shutdownAll()
    this.chatManager.closeAll()
    this.sleepBlocker.release()
    this.hookInjector.cleanupAll()
    await this.hookServer.stop()
    await this.sshManager.disconnectAll().catch(() => {})
    this.relayClient.close()
  }

  private registerEventForwarders(): void {
    for (const endpoint of ['session-start', 'working', 'stopped', 'notification', 'activity']) {
      this.hookServer.on(endpoint, (tabId: string, body: Record<string, unknown>) => this.handleHook(endpoint, tabId, body))
    }

    // The desktop adds its own listener for the browser tabs' SOCKS routing.
    this.sshManager.on('status-changed', (projectId: string, status: string) => {
      this.logDebug(`sshStatus projectId=${projectId} status=${status}`)
      this.clients.broadcast('ssh-status-changed', projectId, status)
    })

    this.sshManager.on('tunnel-status-changed', (projectId: string, status: string, error?: string) => {
      this.logDebug(`tunnelStatus projectId=${projectId} status=${status}${error ? ` error=${error}` : ''}`)
      this.clients.broadcast('ssh-tunnel-status-changed', projectId, status, error)
    })
  }

  /**
   * One hook event, from a terminal tab's curl (hook server) or a chat tab's SDK
   * process (in-process). Each has two consumers: the windows, which draw the
   * status dot for the tabs they mount, and the activity registry, which is what
   * the phone's inbox and the sidebar's activity line read.
   */
  private handleHook(endpoint: string, tabId: string, body: Record<string, unknown>): void {
    if (this.keyInterrupts.hook(tabId, body)) {
      this.activityRegistry.working(tabId)
      this.broadcastToAttachedClients(tabId, 'hook-working', tabId)
    }
    switch (endpoint) {
      case 'session-start':
        this.activityRegistry.touch(tabId)
        this.recordAgentActivity(tabId, body)
        this.broadcastToAttachedClients(tabId, 'hook-session-start', tabId, body)
        return
      case 'working':
        this.activityRegistry.working(tabId)
        this.recordAgentActivity(tabId, body)
        this.broadcastToAttachedClients(tabId, 'hook-working', tabId)
        return
      case 'stopped':
        this.activityRegistry.stopped(tabId)
        this.recordAgentActivity(tabId, body)
        this.broadcastToAttachedClients(tabId, 'hook-stopped', tabId, this.activityRegistry.backgroundTasks(tabId))
        return
      case 'notification':
        this.activityRegistry.notification(tabId, body)
        this.recordAgentActivity(tabId, body)
        this.broadcastToAttachedClients(tabId, 'hook-notification', tabId, body)
        return
      default: {
        // Everything else Claude reports (tools, permission dialogs, API failures,
        // subagents, compaction). `hook-activity` is sent even without a status
        // change, because any hook proves the agent is alive (the stale-working timer).
        const update = this.recordAgentActivity(tabId, body)
        const statusEvent = update?.statusEvent ?? null
        if (statusEvent) this.activityRegistry.statusEvent(tabId, statusEvent)
        this.broadcastToAttachedClients(tabId, 'hook-activity', tabId, statusEvent)
      }
    }
  }

  private createChatManager(): ClaudeChatManager {
    return new ClaudeChatManager({
      sendToClient: (clientId, channel, ...args) => this.clients.send(clientId, channel, ...args),
      resolveLocalClaude: () => resolveAgentCommand(agentCommandOverride('claude', this.config).trim() || 'claude'),
      localEnv: () => getShellEnv(),
      // A chat spawns a fresh remote process per session, so check the master
      // actually reaches the host first: a stale one fails the spawn with 255.
      ensureSsh: (projectId, sshConfig) => this.ensureSshConnected(projectId, sshConfig, { verify: true }),
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
      claudeSpawn: (config, args) => {
        if (config.sshConfig && config.projectId) {
          return {
            file: this.sshManager.getSshCommand(),
            args: this.sshManager.buildStdioSpawnArgs(config.projectId, config.sshConfig, 'claude', args, {}, config.cwd)
          }
        }
        const file = resolveAgentCommand(agentCommandOverride('claude', this.config).trim() || 'claude')
        return { file, args, cwd: config.cwd, env: getShellEnv() }
      },
      remoteExec: (projectId, sshConfig, script) => this.remoteExec(projectId, sshConfig, script),
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
      log: (message) => this.logDebug(message),
      loginRemote: this.remoteClients
    })
  }

  private async ensureSshConnected(projectId: string, sshConfig: SshConfig, options?: { verify?: boolean }): Promise<void> {
    if (this.sshManager.getStatus(projectId) === 'connected') {
      if (!options?.verify || await this.sshManager.verifyConnection(projectId, sshConfig)) return
    }
    await this.sshManager.connect(projectId, sshConfig, { tunnel: this.getProjectTunnel(projectId) ?? null })
    this.sshManager.startHealthChecks(projectId, sshConfig)
  }

  /** The host's IPC handlers, on whatever registrar the caller serves (a desktop's ipcMain). */
  registerIpcHandlers(ipc: IpcRegistrar): void {
    const log = (message: string) => this.logDebug(message)
    const resolveRoot = (dir: string) => this.resolveAllowedDirectory(dir)

    registerAppStateHandlers(ipc, {
      projectsStore: this.projectsStore,
      notesStore: this.notesStore,
      paletteFrecency: this.paletteFrecencyStorage,
      getAgentActivity: () => this.activityRegistry.getActivitySnapshot(),
      getTabStatuses: () => this.hostTabStatuses(),
      restartTabs: (clientId, tabIds) => this.restartTabs(clientId, tabIds),
      reportTabStatus: (clientId, tabId, status) => {
        this.statusReporters.set(tabId, clientId)
        this.activityRegistry.reported(tabId, status)
      },
      setDirtyTabs: (clientId, tabIds) => {
        if (tabIds.length === 0) this.dirtyTabsByClient.delete(clientId)
        else this.dirtyTabsByClient.set(clientId, new Set(tabIds))
      },
      backupProjects: () => this.storage.backupProjectsOnStartup(),
      getConfig: () => this.config,
      applyConfig: (patch) => this.applyConfig(patch),
      log
    })

    registerSshHandlers(ipc, {
      sshManager: () => this.sshManager,
      getProjectTunnel: (projectId) => this.getProjectTunnel(projectId)
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
        this.keyInterrupts.forget(tabId)
        this.activityRegistry.remove(tabId)
        this.broadcastAgentActivity(tabId)
      },
      assertAllowedDirectory: resolveRoot
    })

    registerTerminalHandlers(ipc, { ptySessions: this.ptySessions, log })

    registerWorkspaceHandlers(ipc, {
      ...this.workspaceGit(),
      deleteWorkspace: (request) => this.deleteWorkspace(request)
    })

    registerArchiveHandlers(ipc, {
      archive: this.archiveStorage,
      broadcastChanged: (projectId) => this.clients.broadcast('archive-changed', projectId),
      deleteScrollback: (tabId) => this.scrollbackStorage.delete(tabId),
      readTranscript: async (sessionId, cwd, projectId, sshConfig) => {
        if (projectId && sshConfig) {
          await this.ensureSshConnected(projectId, sshConfig)
          return readRemoteTranscript(sessionId, (script) => this.remoteExec(projectId, sshConfig, script))
        }
        return readLocalTranscript(sessionId, cwd)
      }
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
    registerHostMobileHandlers(ipc, { mobile: () => this.mobileService })
    registerTaskWorktreeHandlers(ipc, { taskWorktrees: this.taskWorktrees })
    registerTaskLandingHandlers(ipc, { taskLanding: this.taskLanding })
    registerPromptQueueHandlers(ipc, { promptQueue: this.promptQueue })
    registerHostFsHandlers(ipc, {
      send: (clientId, channel, ...args) => this.clients.send(clientId, channel, ...args),
      env: () => getShellEnv()
    })
    registerHostAgentHandlers(ipc, {
      detect: () => detectAgentClis({ env: getShellEnv(), config: this.config }),
      refreshEnv: () => this.refreshLoginEnv()
    })
    registerHostSshHandlers(ipc, { isServer: this.isServer })
  }

  /**
   * Run the login shell again and take its env, as at startup: an installer that
   * added to the PATH (`~/.local/bin` exists now, a profile line) is seen by new
   * tabs, chats and the agent detection from here on. Running tabs keep theirs.
   */
  async refreshLoginEnv(): Promise<{ path: string }> {
    await resolveShellEnv()
    const path = getShellEnv().PATH ?? ''
    this.logDebug(`loginEnv refreshed path=${path}`)
    return { path }
  }

  /**
   * A renderer-supplied local directory, accepted only when it is (inside) a
   * known local project or one of its task worktrees; returns its real path.
   */
  resolveAllowedDirectory(dir: string): Promise<string> {
    return resolveAllowedDirectory(dir, allowedLocalRoots(this.projectsStore.peek().projects))
  }

  /**
   * End these tabs' processes (a PTY keeps its scrollback) and tell every client but
   * `clientId`, which already let go of them, to drop its copy: each then mounts
   * them again in the task's new directory and spawns there.
   */
  private restartTabs(clientId: string, tabIds: string[]): void {
    for (const tabId of tabIds) {
      if (this.ptySessions.has(tabId)) this.ptySessions.kill(tabId)
      this.chatManager.close(tabId)
    }
    for (const id of this.clients.clientIds()) {
      if (id !== clientId) this.clients.send(id, 'tabs-restart', { tabIds })
    }
  }

  private applyConfig(patch: Partial<AppConfig>): void {
    this.config = { ...this.config, ...patch }
    this.storage.saveConfig(this.config)
    setPortableNodeDir(this.config.portableNodeDir)
    this.sleepBlocker.update()
    this.clients.broadcast('config-updated', clone(this.config))
    for (const listener of [...this.configListeners]) {
      try {
        listener(this.config)
      } catch (err) {
        this.logDebug(`configListener error=${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** Behind the `workspace-delete` IPC; without `force` it is the pre-flight. */
  /** What the workspace IPC handlers need for git, local or over SSH. */
  private workspaceGit() {
    return {
      workspaceManager: this.workspaceManager,
      remoteWorkspaceManager: this.remoteWorkspaceManager,
      ensureSshConnected: (projectId: string, sshConfig: SshConfig) => this.ensureSshConnected(projectId, sshConfig),
      socketPath: (projectId: string) => this.sshManager.getSocketPath(projectId)
    }
  }

  /** The New stream dialog's git calls, for a phone's `stream.new` and `branches.list`: the same functions its IPC runs. */
  private streamGit(): StreamGit {
    const git = this.workspaceGit()
    return {
      listBranches: (target) => listWorkspaceBranches(git, target),
      createWorkspace: (request) => createWorkspace(git, request)
    }
  }

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

  private logDebug(message: string): void {
    this.env.log(message)
  }

  /**
   * Fold a hook body into the tab's activity and push it to every window — the
   * sidebar lists tasks that are not mounted in the window showing them.
   */
  private recordAgentActivity(tabId: string, body: Record<string, unknown>): ActivityUpdate | null {
    const update = this.activityRegistry.applyHook(tabId, body)
    if (update) this.clients.broadcast('agent-activity', tabId, update.activity)
    return update
  }

  /**
   * A tab's status as main has it, to every window: one that doesn't mount the tab
   * (a task the queue or a phone started, or one open in another window) has no
   * other way to see it. Sent only when the status changed, not on every hook.
   */
  private broadcastTabStatus(tabId: string): void {
    const status = this.activityRegistry.getStatus(tabId)
    if (this.sentTabStatuses.has(tabId) && this.sentTabStatuses.get(tabId) === status) return
    const entry: HostTabStatus = { status, since: this.activityRegistry.getSince(tabId) }
    // A removed tab is forgotten here too.
    if (entry.since === null) this.sentTabStatuses.delete(tabId)
    else this.sentTabStatuses.set(tabId, status)
    this.clients.broadcast('tab-host-status', tabId, entry)
  }

  private hostTabStatuses(): Record<string, HostTabStatus> {
    const since = this.activityRegistry.getSinceSnapshot()
    return Object.fromEntries(Object.entries(this.activityRegistry.getSnapshot())
      .map(([tabId, status]): [string, HostTabStatus] => [tabId, { status, since: since[tabId] ?? null }]))
  }

  private broadcastAgentActivity(tabId: string): void {
    this.clients.broadcast('agent-activity', tabId, this.activityRegistry.getActivity(tabId))
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
      this.clients.broadcast('notebook-kernel-event', tabId, { event: 'fail', code, message })
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

  private broadcastToAttachedClients(tabId: string, channel: string, ...args: unknown[]): void {
    const clientIds = this.ptySessions.attachedClients(tabId) ?? this.chatManager?.attachedClients(tabId)
    if (!clientIds) return
    for (const clientId of clientIds) this.clients.send(clientId, channel, ...args)
  }
}

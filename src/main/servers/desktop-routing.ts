import type { Project, ProjectsData } from '../../shared/types'
import type { ProjectsSources } from '../../shared/projects-sources'
import type { ServersState } from '../../shared/servers'
import type { IpcContext, IpcRegistrar } from '../ipc/registrar'
import { HostRouter, LOCAL_HOST, RouteIndex, type RouterHub } from './host-router'
import { MAIN_CLIENT_ID, ServerProjects } from './server-projects'
import type { ServerEvent } from './server-hub'
import type { ChatImage } from '../../shared/claude-chat'
import type { ImageCodec } from '../mobile/chat-image'
import { fitChatImagesForLink } from './link-chat-images'
import { LinkError, LinkErrorCode } from '../host/link/errors'

/** The part of ServerHub the desktop's routing uses. */
export interface RoutingHub {
  call(serverId: string, clientId: string, ch: string, args?: unknown[], options?: { focused?: boolean }): Promise<unknown>
  getState(): ServersState
  onStateChange(listener: (state: ServersState) => void): () => void
  onEvent(listener: (event: ServerEvent) => void): () => void
}

/** The local host, as far as routing goes. */
export interface RoutedHost {
  getProjectsData(): ProjectsData
  onProjectsChanged(listener: (data: ProjectsData) => void): () => void
}

export interface DesktopRoutingDeps {
  configDir: string
  /** This desktop's windows. */
  windows: {
    send(clientId: string, channel: string, ...args: unknown[]): void
    broadcast(channel: string, ...args: unknown[]): void
  }
  log: (message: string) => void
  /** Scales a server chat's images down to fit a link message (Electron's nativeImage). */
  images?: ImageCodec
}

/**
 * Everything that makes a desktop's windows reach its DevTool servers (plan
 * step 6): the servers' projects (ServerProjects), which host each project,
 * task and tab is on (RouteIndex), and the router in front of the local host's
 * IPC handlers (HostRouter). Built before the HostServices, whose projects
 * store needs the server projects to keep their place in the local order.
 */
export class DesktopRouting {
  readonly projects: ServerProjects
  readonly index = new RouteIndex()
  readonly router: HostRouter
  private hub: RoutingHub | null = null
  private host: RoutedHost | null = null
  private online = new Set<string>()

  constructor(private readonly deps: DesktopRoutingDeps) {
    this.projects = new ServerProjects({
      configDir: deps.configDir,
      localProjects: () => this.host?.getProjectsData().projects ?? [],
      broadcast: (update) => deps.windows.broadcast('projects-updated', update),
      log: deps.log
    })
    this.projects.onChange(() => this.reindex())
    this.router = new HostRouter({
      hub: () => this.routerHub(),
      index: this.index,
      windows: deps.windows,
      onProjectsUpdate: (serverId, update) => this.projects.handleUpdate(serverId, update),
      log: deps.log,
      desktop: {
        'load-projects': (_ctx, args, local) => ({ ...(local(args) as ProjectsSources), ...this.projects.sources() })
      },
      custom: {
        'save-projects': (serverId, ctx, args) =>
          this.projects.save(serverId, ctx.clientId, args[1] as { baseRevision: number; data: ProjectsData }, ctx.isFocused()),
        // Pasted screenshots can outgrow one link message: scaled here, where the codec is.
        'chat-send': (serverId, ctx, args) => this.callServer(serverId, ctx, 'chat-send', [
          args[0],
          args[1],
          deps.images ? fitChatImagesForLink(args[2] as ChatImage[] | undefined, deps.images) : args[2]
        ])
      }
    })
    this.reindex()
  }

  /** Every server project, for the local store (its order and pins name them). */
  foreignProjects(): Project[] {
    return this.projects.foreignProjects()
  }

  /** The local data plus every server's projects: what the windows list. */
  mergedProjects(local: ProjectsData): ProjectsData {
    // A project moving to a server is foreign and local for a moment: listed once.
    const localIds = new Set(local.projects.map(p => p.id))
    return { ...local, projects: [...local.projects, ...this.projects.foreignProjects().filter(p => !localIds.has(p.id))] }
  }

  /** A server's project (known now, or seen before). */
  isServerProject(projectId: string): boolean {
    const host = this.index.hostOfProject(projectId)
    return !!host && host !== LOCAL_HOST
  }

  /** The local host's handlers, registered through the router. */
  wrap<C extends IpcContext>(ipc: IpcRegistrar<C>): IpcRegistrar<C> {
    return this.router.wrap(ipc)
  }

  attachHost(host: RoutedHost): void {
    this.host = host
    host.onProjectsChanged(() => {
      // A server's ids that collide with this desktop's are dropped from its view.
      this.projects.localChanged()
      this.reindex()
    })
    this.projects.localChanged()
    this.reindex()
  }

  attachHub(hub: RoutingHub): void {
    this.hub = hub
    hub.onEvent((event) => this.router.deliver(event))
    // ServerProjects first: a server that comes online is asked for its projects
    // before anything below, and one link answers in order, so the refreshes
    // know its tasks and tabs by the time their answers arrive.
    this.projects.attach(hub)
    hub.onStateChange((state) => this.onServersState(state))
    this.onServersState(hub.getState())
  }

  private callServer(serverId: string, ctx: IpcContext, ch: string, args: unknown[]): Promise<unknown> {
    const hub = this.hub
    if (!hub) return Promise.reject(new LinkError(LinkErrorCode.ServerOffline, 'Servers are not started yet'))
    return hub.call(serverId, ctx.clientId, ch, args, { focused: ctx.isFocused() })
  }

  private routerHub(): RouterHub | null {
    const hub = this.hub
    if (!hub) return null
    return {
      call: (serverId, clientId, ch, args, options) => hub.call(serverId, clientId, ch, args, options),
      onlineServers: () => [...this.online]
    }
  }

  private onServersState(state: ServersState): void {
    const now = new Set(state.servers.filter(s => s.state === 'online').map(s => s.id))
    const came = [...now].filter(id => !this.online.has(id))
    this.online = now
    for (const serverId of came) {
      void this.refreshActivity(serverId)
      void this.refreshWorktreeStates(serverId)
    }
  }

  /**
   * A server came (back) online: its tasks' worktree states (a setup waiting
   * for approval, one being made) go to the windows again, and whatever they
   * still show from before that the server no longer has is cleared: a window
   * opened while it was away, or a server that restarted (held setups live in
   * its memory only), would otherwise wait on a prompt nobody can answer.
   */
  private async refreshWorktreeStates(serverId: string): Promise<void> {
    const hub = this.hub
    if (!hub) return
    try {
      const answer = await hub.call(serverId, MAIN_CLIENT_ID, 'task-worktree-states')
      const states = typeof answer === 'object' && answer !== null && !Array.isArray(answer) ? answer as Record<string, unknown> : {}
      for (const [taskId, state] of Object.entries(states)) {
        // Only its own tasks: a server can't put a prompt on a local task.
        if (this.index.taskOf(taskId, serverId)) this.deps.windows.broadcast('task-worktree-state', taskId, state)
      }
      for (const taskId of this.worktreeTaskIds(serverId)) {
        if (!(taskId in states)) this.deps.windows.broadcast('task-worktree-state', taskId, null)
      }
    } catch (err) {
      this.deps.log(`servers worktreeStatesRefresh server=${serverId} error=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The server's tasks that can have a worktree of their own (a window may show a state for them). */
  private worktreeTaskIds(serverId: string): string[] {
    const ids: string[] = []
    for (const project of this.projects.foreignProjects()) {
      if (project.host !== serverId) continue
      for (const stream of project.streams) {
        if (!stream.workspace || !stream.taskWorktrees) continue
        for (const task of stream.tasks) {
          if (!task.sharesStreamWorktree && this.index.taskOf(task.id, serverId)) ids.push(task.id)
        }
      }
    }
    return ids
  }

  /**
   * A server came (back) online: its agents' activity and statuses may have moved
   * on while the link was down, so the windows get them again, tab by tab.
   */
  private async refreshActivity(serverId: string): Promise<void> {
    const hub = this.hub
    if (!hub) return
    try {
      const activity = await hub.call(serverId, MAIN_CLIENT_ID, 'get-agent-activity') as Record<string, unknown> | null
      for (const [tabId, entry] of Object.entries(activity ?? {})) {
        // Only its own tabs: a server can't set what a local tab shows.
        if (this.index.tabOf(tabId, serverId)) this.deps.windows.broadcast('agent-activity', tabId, entry)
      }
      const statuses = await hub.call(serverId, MAIN_CLIENT_ID, 'get-tab-statuses') as Record<string, unknown> | null
      for (const [tabId, entry] of Object.entries(statuses ?? {})) {
        if (this.index.tabOf(tabId, serverId)) this.deps.windows.broadcast('tab-host-status', tabId, entry)
      }
    } catch (err) {
      this.deps.log(`servers activityRefresh server=${serverId} error=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private reindex(): void {
    this.index.update([...(this.host?.getProjectsData().projects ?? []), ...this.projects.foreignProjects()])
  }
}

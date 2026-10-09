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
    return { ...local, projects: [...local.projects, ...this.projects.foreignProjects()] }
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
    hub.onStateChange((state) => this.onServersState(state))
    this.projects.attach(hub)
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
    for (const serverId of came) void this.refreshActivity(serverId)
  }

  /**
   * A server came (back) online: its agents' activity may have moved on while
   * the link was down, so the windows get it again, tab by tab.
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
    } catch (err) {
      this.deps.log(`servers activityRefresh server=${serverId} error=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private reindex(): void {
    this.index.update([...(this.host?.getProjectsData().projects ?? []), ...this.projects.foreignProjects()])
  }
}

import type { Project } from '../../shared/types'
import type { IpcContext, IpcRegistrar } from '../ipc/registrar'
import { LinkError, LinkErrorCode } from '../host/link/errors'
import { HOST_ROUTES, SERVER_EVENTS, type HostRoute, type RouteKey } from './host-routes'
import type { ServerEvent } from './server-hub'

/** The route of everything this desktop serves itself. */
export const LOCAL_HOST = 'local'

/**
 * Which host each project, task and tab is on, from the merged projects data
 * (this desktop's store plus every server's). Ids are never forgotten: a tab
 * removed from the data keeps its last host, so closing it (`pty-kill`,
 * `chat-close`) still reaches the server running it.
 */
export class RouteIndex {
  private readonly projects = new Map<string, string>()
  private readonly tasks = new Map<string, string>()
  private readonly tabs = new Map<string, string>()

  update(projects: readonly Project[]): void {
    for (const project of projects) {
      const host = project.host ?? LOCAL_HOST
      this.projects.set(project.id, host)
      for (const stream of Array.isArray(project.streams) ? project.streams : []) {
        for (const task of Array.isArray(stream.tasks) ? stream.tasks : []) {
          this.tasks.set(task.id, host)
          for (const pane of Array.isArray(task.panes) ? task.panes : []) {
            for (const tab of Array.isArray(pane.tabs) ? pane.tabs : []) this.tabs.set(tab.id, host)
          }
        }
      }
    }
  }

  remember(kind: 'task' | 'tab', id: string, host: string): void {
    (kind === 'task' ? this.tasks : this.tabs).set(id, host)
  }

  hostOfProject(id: string): string | undefined {
    return this.projects.get(id)
  }

  hostOfTask(id: string): string | undefined {
    return this.tasks.get(id)
  }

  hostOfTab(id: string): string | undefined {
    return this.tabs.get(id)
  }
}

/** The part of {@link ServerHub} the router uses: a fake in tests. */
export interface RouterHub {
  call(serverId: string, clientId: string, ch: string, args: unknown[], options: { focused?: boolean }): Promise<unknown>
  /** Servers with a session right now. */
  onlineServers(): string[]
}

type Handler<C extends IpcContext> = (ctx: C, args: unknown[], local: (args: unknown[]) => unknown) => unknown

export interface HostRouterOptions {
  hub: () => RouterHub | null
  index: RouteIndex
  /** `remote: 'custom'` channels: what a call for a server does instead of a plain call. */
  custom?: Record<string, (serverId: string, ctx: IpcContext, args: unknown[]) => unknown>
  /** `desktop` channels: the desktop's answer, given the local handler. */
  desktop?: Record<string, Handler<IpcContext>>
  /** Where server pushes go. */
  windows: {
    send(clientId: string, channel: string, ...args: unknown[]): void
    broadcast(channel: string, ...args: unknown[]): void
  }
  /** A server's `projects-updated`. */
  onProjectsUpdate: (serverId: string, update: unknown) => void
  log: (message: string) => void
  /** Tests: another table. */
  routes?: Readonly<Record<string, HostRoute>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPromise(value: unknown): value is Promise<unknown> {
  return isRecord(value) && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * The desktop's host router (plan step 6). It sits between the windows' IPC and
 * the local HostServices: every host channel is registered through
 * {@link HostRouter.wrap}, which looks up the channel in {@link HOST_ROUTES}
 * and either runs the local handler or calls the channel on the server through
 * the ServerHub, as the calling window (`win:N`). Pushes from servers come back
 * through {@link HostRouter.deliver}.
 */
export class HostRouter {
  private readonly routes: Readonly<Record<string, HostRoute>>
  private readonly registered = new Set<string>()
  private readonly unknownEvents = new Set<string>()

  constructor(private readonly options: HostRouterOptions) {
    this.routes = options.routes ?? HOST_ROUTES
  }

  /** Channels registered through {@link wrap} so far. */
  channels(): string[] {
    return [...this.registered]
  }

  /**
   * A registrar for HostServices: same channels, same schemas (validated here
   * before anything is sent), each handler wrapped in the routing.
   */
  wrap<C extends IpcContext>(inner: IpcRegistrar<C>): IpcRegistrar<C> {
    // The handlers' argument types come from their schemas; routing treats them as a list.
    type AnyHandler = (ctx: C, ...args: unknown[]) => unknown
    return {
      handle: (channel, schema, handler) => {
        this.claim(channel)
        const run = handler as unknown as AnyHandler
        inner.handle(channel, schema, ((ctx: C, ...args: unknown[]) =>
          this.dispatch(channel, ctx, args, (routed) => run(ctx, ...routed))) as never)
      },
      on: (channel, schema, handler) => {
        this.claim(channel)
        const run = handler as unknown as AnyHandler
        inner.on(channel, schema, ((ctx: C, ...args: unknown[]) => {
          try {
            const result = this.dispatch(channel, ctx, args, (routed) => run(ctx, ...routed))
            if (isPromise(result)) result.catch((err) => this.logFailure(channel, err))
          } catch (err) {
            this.logFailure(channel, err)
          }
        }) as never)
      },
      onSync: (channel, schema, handler, fallback) => {
        this.claim(channel)
        const run = handler as unknown as AnyHandler
        inner.onSync(channel, schema, ((ctx: C, ...args: unknown[]) => {
          const route = this.routes[channel]
          const host = typeof route === 'object' && 'by' in route ? this.resolve(route.by, args) : LOCAL_HOST
          if (host === LOCAL_HOST) return run(ctx, ...args)
          // A synchronous answer can't wait for a server.
          return typeof route === 'object' && 'by' in route && route.remote === 'skip' ? route.skipAnswer : fallback
        }) as never, fallback)
      }
    }
  }

  /** The host a `by` route picks for these arguments: `local`, or a server id. */
  hostFor(channel: string, args: unknown[]): string {
    const route = this.routes[channel]
    if (typeof route === 'object' && 'by' in route) return this.resolve(route.by, args)
    return LOCAL_HOST
  }

  /** A push from a server, for this desktop's windows. */
  deliver(event: ServerEvent): void {
    const rule = SERVER_EVENTS[event.ch]
    if (!rule) {
      if (!this.unknownEvents.has(event.ch)) {
        this.unknownEvents.add(event.ch)
        this.options.log(`router dropUnknownEvent server=${event.serverId} ch=${event.ch}`)
      }
      return
    }
    if (rule === 'drop') return
    if (rule === 'projects') {
      this.options.onProjectsUpdate(event.serverId, event.args[0])
      return
    }
    // Tab and task ids are global, so the arguments go to the windows as they are.
    if (event.client === '*') this.options.windows.broadcast(event.ch, ...event.args)
    else this.options.windows.send(event.client, event.ch, ...event.args)
  }

  private claim(channel: string): void {
    if (!(channel in this.routes)) {
      throw new Error(`Host channel ${channel} has no route: add it to HOST_ROUTES (src/main/servers/host-routes.ts)`)
    }
    this.registered.add(channel)
  }

  private dispatch(channel: string, ctx: IpcContext, args: unknown[], local: (args: unknown[]) => unknown): unknown {
    const route = this.routes[channel]
    if (route === 'local') return local(args)
    if (route === 'desktop') {
      const handler = this.options.desktop?.[channel]
      if (!handler) throw new Error(`No desktop handler for ${channel}`)
      return handler(ctx, args, local)
    }
    if (route === 'merge') return this.merge(channel, ctx, args, local)
    if ('splitTabs' in route) return this.split(channel, route.splitTabs, route.everyServer === true, ctx, args, local)
    const host = this.resolve(route.by, args)
    if (host === LOCAL_HOST) return local(args)
    switch (route.remote ?? 'call') {
      case 'skip':
        return route.skipAnswer
      case 'custom': {
        const custom = this.options.custom?.[channel]
        if (!custom) throw new Error(`No server handler for ${channel}`)
        return custom(host, ctx, args)
      }
      default:
        return this.call(host, channel, ctx, args)
    }
  }

  private call(serverId: string, channel: string, ctx: IpcContext, args: unknown[]): Promise<unknown> {
    const hub = this.options.hub()
    if (!hub) return Promise.reject(new LinkError(LinkErrorCode.ServerOffline, 'Servers are not started yet'))
    return hub.call(serverId, ctx.clientId, channel, args, { focused: ctx.isFocused() })
  }

  /** The first key that resolves wins; tab and task keys then remember that host. */
  private resolve(keys: readonly RouteKey[], args: unknown[]): string {
    let host: string | undefined
    for (const key of keys) {
      host = this.lookup(key, args)
      if (host) break
    }
    if (!host) return LOCAL_HOST
    for (const key of keys) {
      if ('tab' in key && typeof args[key.tab] === 'string') this.options.index.remember('tab', args[key.tab] as string, host)
      if ('task' in key && typeof args[key.task] === 'string') this.options.index.remember('task', args[key.task] as string, host)
    }
    return host
  }

  private lookup(key: RouteKey, args: unknown[]): string | undefined {
    const { index } = this.options
    if ('project' in key) {
      const id = args[key.project]
      return typeof id === 'string' && id ? index.hostOfProject(id) : undefined
    }
    if ('projectField' in key) {
      const [at, field] = key.projectField
      const holder = args[at]
      const id = isRecord(holder) ? holder[field] : undefined
      return typeof id === 'string' && id ? index.hostOfProject(id) : undefined
    }
    if ('task' in key) {
      const id = args[key.task]
      return typeof id === 'string' ? index.hostOfTask(id) : undefined
    }
    if ('tab' in key) {
      const id = args[key.tab]
      return typeof id === 'string' ? index.hostOfTab(id) : undefined
    }
    const named = args[key.host]
    return typeof named === 'string' && named ? named : undefined
  }

  /** This desktop's answer and every online server's, merged (records of tab or task ids). */
  private async merge(channel: string, ctx: IpcContext, args: unknown[], local: (args: unknown[]) => unknown): Promise<unknown> {
    const hub = this.options.hub()
    const remote = (hub?.onlineServers() ?? []).map(serverId => hub!.call(serverId, ctx.clientId, channel, args, { focused: ctx.isFocused() })
      .catch((err) => {
        this.logFailure(channel, err, serverId)
        return null
      }))
    const answers = await Promise.all([Promise.resolve(local(args)), ...remote])
    const merged: Record<string, unknown> = {}
    // The local answer last: on a clash (there shouldn't be one) this desktop wins.
    for (const answer of [...answers.slice(1), answers[0]]) {
      if (isRecord(answer)) Object.assign(merged, answer)
    }
    return merged
  }

  private async split(
    channel: string,
    at: number,
    everyServer: boolean,
    ctx: IpcContext,
    args: unknown[],
    local: (args: unknown[]) => unknown
  ): Promise<unknown> {
    const tabIds = Array.isArray(args[at]) ? (args[at] as unknown[]).filter((id): id is string => typeof id === 'string') : []
    const parts = new Map<string, string[]>()
    for (const tabId of tabIds) {
      const host = this.options.index.hostOfTab(tabId) ?? LOCAL_HOST
      parts.set(host, [...(parts.get(host) ?? []), tabId])
    }
    const withPart = (part: string[]) => args.map((arg, i) => (i === at ? part : arg))
    const hub = this.options.hub()
    const servers = new Set([...parts.keys()].filter(host => host !== LOCAL_HOST))
    if (everyServer) for (const serverId of hub?.onlineServers() ?? []) servers.add(serverId)
    const remote = [...servers].map(serverId => this.call(serverId, channel, ctx, withPart(parts.get(serverId) ?? []))
      .catch((err) => this.logFailure(channel, err, serverId)))
    const result = await local(withPart(parts.get(LOCAL_HOST) ?? []))
    await Promise.all(remote)
    return result
  }

  private logFailure(channel: string, err: unknown, serverId?: string): void {
    // Keystrokes and resizes for an offline server's tab: the overlay already says so.
    if (err instanceof LinkError && err.code === LinkErrorCode.ServerOffline) return
    this.options.log(`router callFailed ch=${channel}${serverId ? ` server=${serverId}` : ''} error=${err instanceof Error ? err.message : String(err)}`)
  }
}

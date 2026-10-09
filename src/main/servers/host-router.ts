import type { Project } from '../../shared/types'
import type { IpcContext, IpcRegistrar } from '../ipc/registrar'
import { LinkError, LinkErrorCode } from '../host/link/errors'
import { HOST_ROUTES, SERVER_EVENTS, SERVER_PRIVATE_EVENTS, type HostRoute, type RouteKey, type ServerEventScope } from './host-routes'
import type { ServerEvent } from './server-hub'

/** The route of everything this desktop serves itself. */
export const LOCAL_HOST = 'local'

type Owners = Map<string, Set<string>>

function addOwner(map: Owners, id: string, host: string): void {
  const owners = map.get(id)
  if (owners) owners.add(host)
  else map.set(id, new Set([host]))
}

/** This desktop when it owns the id; else the one server that does; else nothing (unknown, or claimed twice). */
function soleOwner(owners: ReadonlySet<string> | undefined): string | undefined {
  if (!owners || owners.size === 0) return undefined
  if (owners.has(LOCAL_HOST)) return LOCAL_HOST
  return owners.size === 1 ? owners.values().next().value : undefined
}

/**
 * Which host each project, task and tab is on, from the merged projects data
 * (this desktop's store plus every server's).
 *
 * - An id this desktop owns routes here, whatever a server claims; an id two
 *   servers claim routes nowhere but here. (ServerProjects already drops a
 *   server's ids that collide; this is the second fence.)
 * - A tab is pinned to its host when its process starts there (`pty-spawn`,
 *   `chat-attach`, a kernel start, routed by project), and unpinned when it ends.
 *   A pinned tab's calls and pushes follow the pin, not the data.
 * - An id that left the data keeps its last sole owner, so a tab closed
 *   before it ever started still reaches its host.
 */
export class RouteIndex {
  private projects: Owners = new Map()
  private tasks: Owners = new Map()
  private tabs: Owners = new Map()
  private readonly retired = new Map<string, string>()
  private readonly pins = new Map<string, string>()

  update(projects: readonly Project[]): void {
    const before = this.tabs
    const nextProjects: Owners = new Map()
    const nextTasks: Owners = new Map()
    const nextTabs: Owners = new Map()
    for (const project of projects) {
      const host = project.host ?? LOCAL_HOST
      addOwner(nextProjects, project.id, host)
      for (const stream of Array.isArray(project.streams) ? project.streams : []) {
        for (const task of Array.isArray(stream.tasks) ? stream.tasks : []) {
          addOwner(nextTasks, task.id, host)
          for (const pane of Array.isArray(task.panes) ? task.panes : []) {
            for (const tab of Array.isArray(pane.tabs) ? pane.tabs : []) addOwner(nextTabs, tab.id, host)
          }
        }
      }
    }
    for (const [tabId, owners] of before) {
      if (nextTabs.has(tabId)) continue
      const owner = soleOwner(owners)
      if (owner) this.retired.set(tabId, owner)
    }
    for (const tabId of nextTabs.keys()) this.retired.delete(tabId)
    this.projects = nextProjects
    this.tasks = nextTasks
    this.tabs = nextTabs
  }

  pin(tabId: string, host: string): void {
    this.pins.set(tabId, host)
  }

  unpin(tabId: string): void {
    this.pins.delete(tabId)
  }

  pinnedHost(tabId: string): string | undefined {
    return this.pins.get(tabId)
  }

  hostOfProject(id: string): string | undefined {
    return soleOwner(this.projects.get(id))
  }

  hostOfTask(id: string): string | undefined {
    return soleOwner(this.tasks.get(id))
  }

  hostOfTab(id: string): string | undefined {
    return this.pins.get(id) ?? soleOwner(this.tabs.get(id)) ?? (this.tabs.has(id) ? undefined : this.retired.get(id))
  }

  /** The tab is that server's: pinned there, or (unpinned) only that server's data has it. */
  tabOf(tabId: string, serverId: string): boolean {
    const pinned = this.pins.get(tabId)
    if (pinned !== undefined) return pinned === serverId
    return soleOwner(this.tabs.get(tabId)) === serverId
  }

  taskOf(taskId: string, serverId: string): boolean {
    return soleOwner(this.tasks.get(taskId)) === serverId
  }

  projectOf(projectId: string, serverId: string): boolean {
    return soleOwner(this.projects.get(projectId)) === serverId
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

/** The tab id a route's tab key names, if it has one. */
function tabArg(keys: readonly RouteKey[], args: unknown[]): string | undefined {
  for (const key of keys) {
    if ('tab' in key && typeof args[key.tab] === 'string' && args[key.tab]) return args[key.tab] as string
  }
  return undefined
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
  /** Drops already logged (once per server, channel and reason). */
  private readonly droppedEvents = new Set<string>()

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

  /**
   * A push from a server, for this desktop's windows: only the channels in
   * SERVER_EVENTS, only about what that server owns, and only to the window it
   * names (or every window for `*`). Anything else is dropped and logged.
   */
  deliver(event: ServerEvent): void {
    const { serverId, ch } = event
    const scope = SERVER_EVENTS[ch]
    if (!scope) {
      if (!SERVER_PRIVATE_EVENTS.includes(ch)) this.logDrop(serverId, ch, 'not a forwarded channel')
      return
    }
    if (scope === 'projects') {
      // Always this server's own source, whatever the push names.
      this.options.onProjectsUpdate(serverId, event.args[0])
      return
    }
    const args = this.ownedArgs(scope, serverId, event.args)
    if (!args) {
      this.logDrop(serverId, ch, 'not about something it owns')
      return
    }
    if (event.client === '*') {
      if (scope === 'own-window') {
        this.logDrop(serverId, ch, 'a broadcast of a per-window push')
        return
      }
      this.options.windows.broadcast(ch, ...args)
    } else if (typeof event.client === 'string' && /^win:\d+$/.test(event.client)) {
      this.options.windows.send(event.client, ch, ...args)
    } else {
      this.logDrop(serverId, ch, `no such window ${String(event.client)}`)
    }
  }

  /** The push's arguments when they are about what `serverId` owns (cut down where a list allows); null otherwise. */
  private ownedArgs(scope: Exclude<ServerEventScope, 'projects'>, serverId: string, args: unknown[]): unknown[] | null {
    const { index } = this.options
    const first = args[0]
    switch (scope) {
      case 'pinned-tab':
        return typeof first === 'string' && index.pinnedHost(first) === serverId ? args : null
      case 'server-tab':
        return typeof first === 'string' && index.tabOf(first, serverId) ? args : null
      case 'server-task':
        return typeof first === 'string' && index.taskOf(first, serverId) ? args : null
      case 'server-project':
        return typeof first === 'string' && index.projectOf(first, serverId) ? args : null
      case 'removal': {
        if (!isRecord(first) || typeof first.projectId !== 'string' || !index.projectOf(first.projectId, serverId)) return null
        if (typeof first.taskId !== 'string' || !index.taskOf(first.taskId, serverId)) return null
        const tabIds = Array.isArray(first.tabIds) ? first.tabIds.filter((id): id is string => typeof id === 'string' && index.tabOf(id, serverId)) : []
        return [{ projectId: first.projectId, taskId: first.taskId, tabIds }, ...args.slice(1)]
      }
      case 'tab-list': {
        if (!isRecord(first) || !Array.isArray(first.tabIds)) return null
        const tabIds = first.tabIds.filter((id): id is string => typeof id === 'string' && index.tabOf(id, serverId))
        return tabIds.length > 0 ? [{ ...first, tabIds }, ...args.slice(1)] : null
      }
      case 'own-window':
        return args
      case 'server-self':
        return [serverId, ...args]
    }
  }

  private logDrop(serverId: string, ch: string, reason: string): void {
    const key = `${serverId}\u0000${ch}\u0000${reason}`
    if (this.droppedEvents.has(key)) return
    this.droppedEvents.add(key)
    this.options.log(`router dropServerEvent server=${serverId} ch=${ch} reason=${reason}`)
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
    if ('merge' in route) return this.merge(channel, route.merge, ctx, args, local)
    if ('splitTabs' in route) return this.split(channel, route.splitTabs, route.everyServer === true, ctx, args, local)
    const { host, via } = this.resolveVia(route.by, args)
    const tabId = tabArg(route.by, args)
    if (tabId && route.pin === 'set' && via !== 'default') this.options.index.pin(tabId, host)
    if (tabId && route.pin === 'clear') this.options.index.unpin(tabId)
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

  /** The first key that resolves wins; none means this desktop. */
  private resolve(keys: readonly RouteKey[], args: unknown[]): string {
    return this.resolveVia(keys, args).host
  }

  private resolveVia(keys: readonly RouteKey[], args: unknown[]): { host: string; via: 'key' | 'default' } {
    for (const key of keys) {
      const host = this.lookup(key, args)
      if (host) return { host, via: 'key' }
    }
    return { host: LOCAL_HOST, via: 'default' }
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

  /**
   * This desktop's answer and every online server's, merged: records keyed by
   * tab or task id, each server's cut down to the ids it owns.
   */
  private async merge(channel: string, keys: 'tabs' | 'tasks', ctx: IpcContext, args: unknown[], local: (args: unknown[]) => unknown): Promise<unknown> {
    const hub = this.options.hub()
    const { index } = this.options
    const owns = (id: string, serverId: string) => (keys === 'tabs' ? index.tabOf(id, serverId) : index.taskOf(id, serverId))
    const remote = (hub?.onlineServers() ?? []).map(serverId => hub!.call(serverId, ctx.clientId, channel, args, { focused: ctx.isFocused() })
      .then(answer => (isRecord(answer) ? Object.fromEntries(Object.entries(answer).filter(([id]) => owns(id, serverId))) : null))
      .catch((err) => {
        this.logFailure(channel, err, serverId)
        return null
      }))
    const answers = await Promise.all([Promise.resolve(local(args)), ...remote])
    const merged: Record<string, unknown> = {}
    // The local answer last: on a clash this desktop wins.
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

import { Socks5Server, type Socks5Target } from './socks5-server'
import { spliceTcp, type TcpTarget } from '../host/link/tcp-stream'
import type { LinkStream } from '../host/link/stream'

/** After the last browser tab of a server lets go, its listener waits this long before it stops. */
export const BROWSER_PROXY_IDLE_MS = 60_000

export interface ServerBrowserProxiesDeps {
  /** A connected `tcp` stream on the server (connectTcpStream); rejects with a TcpConnectError. */
  openTcp: (serverId: string, target: TcpTarget) => Promise<LinkStream>
  /** Points the project's browser session (`persist:browser-<projectId>`) at the SOCKS port. */
  route: (projectId: string, port: number) => Promise<void>
  log: (message: string) => void
  idleMs?: number
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
}

interface Proxy {
  socks: Socks5Server
  /** Resolves to the port once listening. */
  ready: Promise<number>
  /** `<clientId>\0<tabId>` of the browser tabs using it. */
  holds: Set<string>
  idleTimer: unknown
}

const realTimers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

function holdKey(clientId: string, tabId: string): string {
  return `${clientId}\u0000${tabId}`
}

/**
 * The browser tabs of server projects (plan step 9): one SOCKS5 listener per
 * server on 127.0.0.1 and an ephemeral port, started when a tab of one of its
 * projects first needs it and stopped a while after the last one lets go. Each
 * CONNECT becomes a `tcp` stream the server dials, so `localhost` in such a tab
 * is the server. A project's browser session is routed through its server's
 * port before the tab may load anything, and stays routed: with the listener
 * gone, its pages fail rather than reach this computer's localhost.
 */
export class ServerBrowserProxies {
  private readonly proxies = new Map<string, Proxy>()
  /** The port each project's browser session was last pointed at. */
  private readonly routed = new Map<string, number>()
  private readonly timers: NonNullable<ServerBrowserProxiesDeps['timers']>

  constructor(private readonly deps: ServerBrowserProxiesDeps) {
    this.timers = deps.timers ?? realTimers
  }

  /**
   * A browser tab of `projectId` (on `serverId`) wants its pages to load: starts
   * the server's listener if needed, routes the project's session through it,
   * and holds it until {@link release}. Answers the port.
   */
  async acquire(serverId: string, projectId: string, clientId: string, tabId: string): Promise<number> {
    const proxy = this.proxyFor(serverId)
    proxy.holds.add(holdKey(clientId, tabId))
    this.clearIdle(proxy)
    let port: number
    try {
      port = await proxy.ready
    } catch (err) {
      proxy.holds.delete(holdKey(clientId, tabId))
      if (this.proxies.get(serverId) === proxy) this.proxies.delete(serverId)
      throw err
    }
    if (this.routed.get(projectId) !== port) {
      await this.deps.route(projectId, port)
      this.routed.set(projectId, port)
      this.deps.log(`serverBrowser routed project=${projectId} server=${serverId} port=${port}`)
    }
    return port
  }

  /** The tab closed (or moved to another window, which acquires again). */
  release(clientId: string, tabId: string): void {
    const key = holdKey(clientId, tabId)
    for (const [serverId, proxy] of this.proxies) {
      if (proxy.holds.delete(key) && proxy.holds.size === 0) this.scheduleIdle(serverId, proxy)
    }
  }

  /** A window closed: its tabs let go. */
  releaseClient(clientId: string): void {
    const prefix = `${clientId}\u0000`
    for (const [serverId, proxy] of this.proxies) {
      let changed = false
      for (const key of [...proxy.holds]) {
        if (key.startsWith(prefix)) {
          proxy.holds.delete(key)
          changed = true
        }
      }
      if (changed && proxy.holds.size === 0) this.scheduleIdle(serverId, proxy)
    }
  }

  /** The listener's port, while there is one. */
  port(serverId: string): number | undefined {
    const proxy = this.proxies.get(serverId)
    return proxy && proxy.socks.port > 0 ? proxy.socks.port : undefined
  }

  /** The server was removed: its listener stops now. */
  async forget(serverId: string): Promise<void> {
    const proxy = this.proxies.get(serverId)
    if (!proxy) return
    this.proxies.delete(serverId)
    this.clearIdle(proxy)
    await proxy.socks.close()
  }

  async stop(): Promise<void> {
    await Promise.all([...this.proxies.keys()].map((serverId) => this.forget(serverId)))
  }

  private proxyFor(serverId: string): Proxy {
    const existing = this.proxies.get(serverId)
    if (existing) return existing
    const socks = new Socks5Server({
      connect: (target: Socks5Target) => this.deps.openTcp(serverId, { host: target.host, port: target.port }),
      splice: (client, upstream) => spliceTcp(client, upstream as LinkStream),
      log: (message) => this.deps.log(`serverBrowser server=${serverId} ${message}`)
    })
    const proxy: Proxy = { socks, ready: socks.listen(0), holds: new Set(), idleTimer: null }
    proxy.ready.then(
      (port) => this.deps.log(`serverBrowser listening server=${serverId} port=${port}`),
      (err: unknown) => this.deps.log(`serverBrowser listen failed server=${serverId} error=${err instanceof Error ? err.message : String(err)}`)
    )
    this.proxies.set(serverId, proxy)
    return proxy
  }

  private clearIdle(proxy: Proxy): void {
    if (proxy.idleTimer === null) return
    this.timers.clearTimeout(proxy.idleTimer)
    proxy.idleTimer = null
  }

  private scheduleIdle(serverId: string, proxy: Proxy): void {
    this.clearIdle(proxy)
    proxy.idleTimer = this.timers.setTimeout(() => {
      proxy.idleTimer = null
      if (proxy.holds.size > 0 || this.proxies.get(serverId) !== proxy) return
      this.deps.log(`serverBrowser idle server=${serverId}: stopping its listener`)
      void this.forget(serverId)
    }, this.deps.idleMs ?? BROWSER_PROXY_IDLE_MS)
  }
}


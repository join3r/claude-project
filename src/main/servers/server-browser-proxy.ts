import { randomBytes } from 'crypto'
import { AuthProxyServer } from './auth-proxy'
import { serverAlias } from './ssh-config'
import { spliceTcp, type TcpTarget } from '../host/link/tcp-stream'
import type { LinkStream } from '../host/link/stream'

/** After the last browser tab of a server lets go, its listener waits this long before it stops. */
export const BROWSER_PROXY_IDLE_MS = 60_000

export interface ServerBrowserProxiesDeps {
  /** A connected `tcp` stream on the server (connectTcpStream); rejects with a TcpConnectError. */
  openTcp: (serverId: string, target: TcpTarget) => Promise<LinkStream>
  /** Points the project's browser session (`persist:browser-<projectId>`) at the proxy's port. */
  route: (projectId: string, port: number) => Promise<void>
  log: (message: string) => void
  idleMs?: number
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
}

interface Proxy {
  server: AuthProxyServer
  /** Its Basic credentials: `devtool-<id12>` and 32 random bytes, new for every listener. */
  username: string
  password: string
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

/** What Electron's `login` event says about a proxy's challenge. */
export interface ProxyAuthInfo {
  isProxy: boolean
  host: string
  port: number
  realm?: string
}

/**
 * The browser tabs of server projects (plan step 9): one authenticated HTTP
 * proxy per server ({@link AuthProxyServer}) on 127.0.0.1 and an ephemeral
 * port, started when a tab of one of its projects first needs it and stopped a
 * while after the last one lets go. Each request becomes a `tcp` stream the
 * server dials, so `localhost` in such a tab is the server. A project's browser
 * session is routed through its server's port before the tab may load
 * anything, and stays routed: with the listener gone, its pages fail rather
 * than reach this computer's localhost. Only DevTool knows the credentials,
 * and it hands them to Chromium's challenge for exactly that host and port.
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

  /**
   * Credentials for a proxy challenge, only when it comes from one of these
   * listeners: a proxy, at 127.0.0.1 and that port, with our realm. Null for
   * every other challenge, which DevTool leaves alone.
   */
  credentialsFor(info: ProxyAuthInfo): { username: string; password: string } | null {
    if (!info.isProxy || info.host !== '127.0.0.1') return null
    for (const proxy of this.proxies.values()) {
      if (proxy.server.port === 0 || proxy.server.port !== info.port) continue
      if (info.realm !== undefined && info.realm !== proxy.username) return null
      return { username: proxy.username, password: proxy.password }
    }
    return null
  }

  /** The listener's port, while there is one. */
  port(serverId: string): number | undefined {
    const proxy = this.proxies.get(serverId)
    return proxy && proxy.server.port > 0 ? proxy.server.port : undefined
  }

  /** The server was removed: its listener stops now. */
  async forget(serverId: string): Promise<void> {
    const proxy = this.proxies.get(serverId)
    if (!proxy) return
    this.proxies.delete(serverId)
    this.clearIdle(proxy)
    await proxy.server.close()
  }

  async stop(): Promise<void> {
    await Promise.all([...this.proxies.keys()].map((serverId) => this.forget(serverId)))
  }

  private proxyFor(serverId: string): Proxy {
    const existing = this.proxies.get(serverId)
    if (existing) return existing
    const username = serverAlias(serverId)
    const password = randomBytes(32).toString('base64url')
    const server = new AuthProxyServer({
      username,
      password,
      realm: username,
      connect: (target) => this.deps.openTcp(serverId, target),
      splice: (client, upstream) => spliceTcp(client, upstream as LinkStream),
      log: (message) => this.deps.log(`serverBrowser server=${serverId} ${message}`)
    })
    const proxy: Proxy = { server, username, password, ready: server.listen(0), holds: new Set(), idleTimer: null }
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


/** Electron's `login` event, as far as {@link proxyLoginHandler} reads it. */
export type LoginHandler = (
  event: { preventDefault(): void },
  webContents: unknown,
  details: unknown,
  authInfo: ProxyAuthInfo,
  callback: (username?: string, password?: string) => void
) => void

/**
 * The handler for Electron's app `login` event (emitted for every webContents,
 * webview guests included): it answers a proxy challenge only when it comes from
 * one of DevTool's server proxies, and leaves every other challenge alone (no
 * preventDefault, so Electron cancels it as it would without DevTool).
 */
export function proxyLoginHandler(proxies: () => Pick<ServerBrowserProxies, 'credentialsFor'> | null): LoginHandler {
  return (event, _webContents, _details, authInfo, callback) => {
    const credentials = proxies()?.credentialsFor(authInfo)
    if (!credentials) return
    event.preventDefault()
    callback(credentials.username, credentials.password)
  }
}

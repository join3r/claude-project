import { app, session } from 'electron'
import type { SshConnectionManager } from '../ssh-connection-manager'
import { proxyLoginHandler, type ServerBrowserProxies } from '../servers/server-browser-proxy'
import type { IpcRegistrar } from './registrar'
import { safeId, sshConfig } from './schemas'

/** The browser-tab session of a project, whose traffic the SOCKS proxy carries. */
export function projectBrowserSession(projectId: string): Electron.Session {
  return session.fromPartition(`persist:browser-${projectId}`)
}

/** Route a project's browser tabs through the SOCKS proxy on `port`. */
export async function routeBrowserThroughSocks(projectId: string, port: number): Promise<void> {
  const ses = projectBrowserSession(projectId)
  await ses.setProxy({
    proxyRules: `socks5://127.0.0.1:${port}`,
    proxyBypassRules: '<-loopback>'
  })
  await ses.closeAllConnections()
}

/**
 * Route a server project's browser tabs through its server's authenticated HTTP
 * proxy (plan step 9). Loopback isn't bypassed: `localhost` is the server's.
 */
export async function routeBrowserThroughServerProxy(projectId: string, port: number): Promise<void> {
  const ses = projectBrowserSession(projectId)
  await ses.setProxy({
    proxyRules: `http://127.0.0.1:${port}`,
    proxyBypassRules: '<-loopback>'
  })
  await ses.closeAllConnections()
}

/** Answers the server proxies' auth challenges (and no one else's) for every webContents. */
export function answerServerProxyLogins(proxies: () => ServerBrowserProxies | null): void {
  const handle = proxyLoginHandler(proxies)
  app.on('login', (event, webContents, details, authInfo, callback) => handle(event, webContents, details, authInfo, callback))
}

/** Put a project's browser tabs back on a direct connection, ignoring failures. */
export async function routeBrowserDirectQuietly(projectId: string): Promise<void> {
  const ses = projectBrowserSession(projectId)
  await ses.setProxy({ proxyRules: 'direct://' }).catch(() => {})
  await ses.closeAllConnections().catch(() => {})
}

export interface SocksProxyDeps {
  sshManager: () => SshConnectionManager
  /** Desired SOCKS state per project (survives reconnects). */
  socksProxyEnabled: Map<string, boolean>
  /** In-flight SOCKS starts, so concurrent enables share one proxy. */
  socksProxyStarting: Map<string, Promise<number>>
  broadcast: (channel: string, ...args: unknown[]) => void
  log: (message: string) => void
}

/**
 * The per-project SOCKS proxy that carries an SSH project's browser tabs, and
 * `ssh-disconnect`, which has to put those tabs back on a direct connection
 * first. Desktop only: the routing lives in Electron's browser sessions.
 */
export function registerSocksProxyHandlers(ipc: IpcRegistrar, deps: SocksProxyDeps): void {
  const { socksProxyEnabled, socksProxyStarting, broadcast, log } = deps

  ipc.handle('ssh-disconnect', [safeId, sshConfig], async (_event, projectId, config) => {
    // Reset session proxy before disconnect since stopSocksProxy suppresses the exit event
    if (socksProxyEnabled.get(projectId)) {
      await routeBrowserDirectQuietly(projectId)
      broadcast('socks-proxy-status-changed', projectId, false)
    }
    await deps.sshManager().disconnect(projectId, config)
  })

  ipc.handle('socks-proxy-enable', [safeId, sshConfig], async (_event, projectId, config) => {
    const manager = deps.sshManager()
    log(`socksProxyEnable projectId=${projectId} sshStatus=${manager.getStatus(projectId)}`)
    socksProxyEnabled.set(projectId, true)

    const pending = socksProxyStarting.get(projectId)
    if (pending) {
      const port = await pending
      return { port }
    }

    const startPromise = (async () => {
      log(`socksProxyEnable starting proxy for ${projectId}`)
      const port = await manager.startSocksProxy(projectId, config)
      log(`socksProxyEnable proxy started on port ${port}`)
      // Re-check desired state after async startup — a disable may have raced us
      if (!socksProxyEnabled.get(projectId)) {
        await manager.stopSocksProxy(projectId)
        throw new Error('SOCKS proxy was disabled during startup')
      }
      await routeBrowserThroughSocks(projectId, port)
      log(`socksProxyEnable session configured for ${projectId} port=${port}`)
      broadcast('socks-proxy-status-changed', projectId, true, port)
      return port
    })()

    socksProxyStarting.set(projectId, startPromise)
    try {
      const port = await startPromise
      log(`socksProxyEnable success projectId=${projectId} port=${port}`)
      return { port }
    } catch (err) {
      log(`socksProxyEnable FAILED projectId=${projectId} error=${err instanceof Error ? err.message : String(err)}`)
      socksProxyEnabled.set(projectId, false)
      throw err
    } finally {
      socksProxyStarting.delete(projectId)
    }
  })

  ipc.handle('socks-proxy-disable', [safeId], async (_event, projectId) => {
    socksProxyEnabled.set(projectId, false)
    await deps.sshManager().stopSocksProxy(projectId)
    const ses = projectBrowserSession(projectId)
    await ses.setProxy({ proxyRules: 'direct://' })
    await ses.closeAllConnections()
    broadcast('socks-proxy-status-changed', projectId, false)
  })

  ipc.handle('socks-proxy-status', [safeId], (_event, projectId) => {
    const hasEntry = socksProxyEnabled.has(projectId)
    const enabled = hasEntry ? socksProxyEnabled.get(projectId)! : undefined
    const proxy = deps.sshManager().getSocksProxy(projectId)
    log(`socksProxyStatus projectId=${projectId} hasEntry=${hasEntry} enabled=${enabled} port=${proxy?.port}`)
    return { enabled, port: proxy?.port }
  })
}

export interface ServerBrowserDeps {
  proxies: () => ServerBrowserProxies
  /** The DevTool server a project lives on; null for this desktop's own projects. */
  serverOf: (projectId: string) => string | null
}

/**
 * Browser tabs of DevTool server projects (plan step 9): the tab asks before it
 * loads anything, main points `persist:browser-<projectId>` at that server's
 * authenticated proxy (`servers/server-browser-proxy.ts`) and holds it for the
 * tab. There is no direct fallback: `localhost` in such a tab is the server.
 */
export function registerServerBrowserHandlers(ipc: IpcRegistrar, deps: ServerBrowserDeps): void {
  ipc.handle('server-browser-proxy', [safeId, safeId], async (ctx, projectId, tabId) => {
    const serverId = deps.serverOf(projectId)
    if (!serverId) throw new Error('This project is not on a DevTool server')
    const port = await deps.proxies().acquire(serverId, projectId, ctx.clientId, tabId)
    return { port }
  })

  ipc.handle('server-browser-proxy-release', [safeId, safeId], (ctx, _projectId, tabId) => {
    deps.proxies().release(ctx.clientId, tabId)
  })
}

import { session } from 'electron'
import type { SshConnectionManager } from '../ssh-connection-manager'
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

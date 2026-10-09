import type { SshConfig, TunnelConfig } from '../../shared/types'
import type { SshConnectionManager } from '../ssh-connection-manager'
import type { IpcRegistrar } from './registrar'
import { safeId, sshConfig, tunnelConfig } from './schemas'
import { v } from './validate'

export interface SshDeps {
  sshManager: () => SshConnectionManager
  getProjectTunnel: (projectId: string) => TunnelConfig | undefined
}

/**
 * SSH connections and the project tunnel. Disconnecting and the SOCKS proxy are
 * the desktop's (`socks-proxy.ts`): both move the project's browser tabs.
 */
export function registerSshHandlers(ipc: IpcRegistrar, deps: SshDeps): void {
  ipc.handle('ssh-connect', [safeId, sshConfig], async (_event, projectId, config: SshConfig) => {
    // The tunnel and the SOCKS proxy are restored by the manager's connect
    // path and the 'connected' status handler respectively, so that automatic
    // reconnects go through exactly the same restoration as this one.
    const manager = deps.sshManager()
    await manager.connect(projectId, config, { tunnel: deps.getProjectTunnel(projectId) ?? null })
    manager.startHealthChecks(projectId, config)
  })

  ipc.handle('ssh-status', [safeId], (_event, projectId) => deps.sshManager().getStatus(projectId))

  ipc.handle('ssh-set-tunnel', [safeId, sshConfig, v.nullable(tunnelConfig)], async (_event, projectId, config, tunnel) => {
    await deps.sshManager().setTunnel(projectId, config, tunnel)
  })

  ipc.handle('ssh-tunnel-status', [safeId], (_event, projectId) =>
    JSON.parse(JSON.stringify(deps.sshManager().getTunnelState(projectId))))
}

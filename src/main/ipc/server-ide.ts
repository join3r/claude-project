import type { ServerIdeConsent, ServerIdeState } from '../../shared/server-ide'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import { v } from './validate'

export interface ServerIdeIpcDeps {
  state: (serverId: string) => Promise<ServerIdeState>
  setup: (serverId: string, consent: ServerIdeConsent) => Promise<ServerIdeState>
  /** The DevTool server a project lives on; null for this desktop's own projects. */
  serverOf: (projectId: string) => string | null
}

/**
 * Open in IDE for server projects (plan step 9), desktop only: what still needs
 * the user's OK (null for a local project), and the setup they agreed to. The
 * opening itself is `open-in-ide` (ipc/window.ts).
 */
export function registerServerIdeHandlers(ipc: IpcRegistrar, deps: ServerIdeIpcDeps): void {
  ipc.handle('server-ide-state', [safeId], async (_ctx, projectId) => {
    const serverId = deps.serverOf(projectId)
    return serverId ? deps.state(serverId) : null
  })

  ipc.handle('server-ide-setup', [safeId, v.object({ include: v.boolean(), key: v.boolean() })], async (_ctx, projectId, consent) => {
    const serverId = deps.serverOf(projectId)
    if (!serverId) throw new Error('This project is not on a DevTool server')
    return deps.setup(serverId, consent)
  })
}

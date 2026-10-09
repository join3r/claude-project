import { authorizeDesktopKey, revokeDesktopKey, type SshKeyHome } from '../host-ssh-keys'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import { v } from './validate'

export interface HostSshDeps {
  /** Only a DevTool server takes a desktop's key; a desktop's own host refuses. */
  isServer: boolean
  where?: () => SshKeyHome
}

const NOT_A_SERVER = 'Only a DevTool server authorizes DevTool\'s SSH key'
const publicKey = v.string({ nonEmpty: true, max: 512 })

/**
 * Open in IDE's key on a server (plan step 9): the desktop's main calls these
 * through the link, never a window. The first argument names the host for the
 * desktop's router (`{host: 0}`) and is ignored here.
 */
export function registerHostSshHandlers(ipc: IpcRegistrar, deps: HostSshDeps): void {
  ipc.handle('host-ssh-authorize-key', [safeId, v.object({ publicKey, comment: v.string({ max: 128 }) })], (_ctx, _host, request) => {
    if (!deps.isServer) throw new Error(NOT_A_SERVER)
    return authorizeDesktopKey(request, deps.where?.())
  })

  ipc.handle('host-ssh-revoke-key', [safeId, v.object({ publicKey })], (_ctx, _host, request) => {
    if (!deps.isServer) throw new Error(NOT_A_SERVER)
    return revokeDesktopKey(request.publicKey, deps.where?.())
  })
}

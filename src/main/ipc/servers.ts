import type { ServerDeviceCode, ServerInvite, ServerRemoveOptions, ServerStatus, ServersState, ServerUpdateResult } from '../../shared/servers'
import type { IpcRegistrar } from './registrar'
import { v } from './validate'

/** The part of ServerHub the windows drive (5b builds Add server and Settings → Servers on it). */
export interface ServersControl {
  getState(): ServersState
  createInvite(): ServerInvite
  cancelInvite(): void
  pairWithCode(code: string): Promise<ServerStatus>
  rename(serverId: string, name: string): ServerStatus
  remove(serverId: string, options?: ServerRemoveOptions): Promise<{ uninstalled: boolean }>
  restartServer(serverId: string): Promise<void>
  deviceCode(serverId: string): Promise<ServerDeviceCode>
  updateServer(serverId: string): Promise<ServerUpdateResult>
}

/** Server device IDs are 32 lowercase hex characters (SPEC.md §1). */
const serverId = v.string({ pattern: /^[0-9a-f]{32}$/, patternName: 'a server id' })
const removeOptions = v.optional(v.object({ uninstall: v.optional(v.boolean()), keepData: v.optional(v.boolean()) }))

/**
 * DevTool servers. Every change is also broadcast as `servers-state-changed`;
 * failures reject with a message meant for the user.
 */
export function registerServerHandlers(ipc: IpcRegistrar, deps: { servers: () => ServersControl }): void {
  ipc.handle('servers-get-state', [], () => deps.servers().getState())
  ipc.handle('servers-create-invite', [], () => deps.servers().createInvite())
  ipc.handle('servers-cancel-invite', [], () => {
    deps.servers().cancelInvite()
    return deps.servers().getState()
  })
  ipc.handle('servers-pair-code', [v.string({ nonEmpty: true, max: 1024 })], (_event, code) => deps.servers().pairWithCode(code))
  ipc.handle('servers-rename', [serverId, v.string({ nonEmpty: true, max: 200 })], (_event, id, name) => deps.servers().rename(id, name))
  ipc.handle('servers-remove', [serverId, removeOptions], (_event, id, options) => deps.servers().remove(id, options ?? {}))
  ipc.handle('servers-restart', [serverId], (_event, id) => deps.servers().restartServer(id))
  ipc.handle('servers-device-code', [serverId], (_event, id) => deps.servers().deviceCode(id))
  ipc.handle('servers-update', [serverId], (_event, id) => deps.servers().updateServer(id))
}

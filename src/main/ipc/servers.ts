import type { ServerDeviceCode, ServerInvite, ServerRemoveOptions, ServerStatus, ServersState, ServerUpdateResult, SshInstallTarget } from '../../shared/servers'
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

/** The part of SshInstallSessions the windows drive. */
export interface SshInstallControl {
  start(clientId: string, target: SshInstallTarget, size: { cols: number; rows: number }): { sessionId: string; target: string }
  write(clientId: string, sessionId: string, data: string): void
  resize(clientId: string, sessionId: string, cols: number, rows: number): void
  stop(clientId: string, sessionId: string): void
}

const sessionId = v.string({ pattern: /^ssh-install-\d{1,9}$/, patternName: 'an SSH install session' })
const sshTarget = v.object({
  host: v.string({ nonEmpty: true, max: 253 }),
  user: v.optional(v.string({ nonEmpty: true, max: 64 })),
  port: v.optional(v.number({ int: true, min: 1, max: 65535 })),
  keyFile: v.optional(v.string({ nonEmpty: true, max: 1024 }))
})
const termSize = v.object({ cols: v.number({ int: true, min: 1, max: 1000 }), rows: v.number({ int: true, min: 1, max: 1000 }) })

/**
 * Add server › Install over SSH. Desktop-only: the pty runs here, on this
 * computer, and talks only to the window that started it
 * (`servers-ssh-install-data` and `-exit`). Main picks the install token itself;
 * it never crosses this IPC.
 */
export function registerSshInstallHandlers(ipc: IpcRegistrar, deps: { sshInstalls: () => SshInstallControl }): void {
  ipc.handle('servers-ssh-install-start', [sshTarget, termSize], (ctx, target, size) => deps.sshInstalls().start(ctx.clientId, target, size))
  ipc.on('servers-ssh-install-input', [sessionId, v.string({ max: 65536 })], (ctx, id, data) => deps.sshInstalls().write(ctx.clientId, id, data))
  ipc.on('servers-ssh-install-resize', [sessionId, v.number({ int: true, min: 1, max: 1000 }), v.number({ int: true, min: 1, max: 1000 })], (ctx, id, cols, rows) => deps.sshInstalls().resize(ctx.clientId, id, cols, rows))
  ipc.handle('servers-ssh-install-stop', [sessionId], (ctx, id) => deps.sshInstalls().stop(ctx.clientId, id))
}

import { cloneHostRepo, discoverHostRepos, listHostDirectories } from '../host-fs'
import { CLONE_PROGRESS_CHANNEL } from '../../shared/host-fs'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import { v } from './validate'

export interface HostFsDeps {
  /** Push to one client (the clone's progress goes to the window that asked). */
  send: (clientId: string, channel: string, ...args: unknown[]) => void
  /** The login env, for git (its PATH and credential helpers). */
  env: () => NodeJS.ProcessEnv
}

/**
 * Adding a project to a host from a window: browse its folders, find its git
 * repos, clone one. A paired desktop already runs shells on its server, so the
 * folders aren't confined to projects; the first argument (`local` or a server
 * id) is the desktop router's and is ignored here.
 */
export function registerHostFsHandlers(ipc: IpcRegistrar, deps: HostFsDeps): void {
  ipc.handle('server-list-dirs', [safeId, v.string({ max: 4096 }), v.optional(v.object({ showHidden: v.optional(v.boolean()) }))],
    (_ctx, _host, dir, options) => listHostDirectories(dir, { showHidden: options?.showHidden === true }))

  ipc.handle('server-discover-repos', [safeId, v.optional(v.object({
    root: v.optional(v.string({ max: 4096 })),
    maxDepth: v.optional(v.number({ int: true, min: 0, max: 6 }))
  }))], (_ctx, _host, options) => discoverHostRepos({ root: options?.root, maxDepth: options?.maxDepth }))

  ipc.handle('server-clone-repo', [safeId, v.object({
    url: v.string({ nonEmpty: true, max: 2048 }),
    parentDir: v.optional(v.string({ max: 4096 })),
    name: v.optional(v.string({ max: 255 })),
    opId: v.string({ nonEmpty: true, max: 64 })
  })], (ctx, _host, request) => cloneHostRepo(request, {
    env: deps.env(),
    onProgress: (line) => deps.send(ctx.clientId, CLONE_PROGRESS_CHANNEL, request.opId, line)
  }))
}

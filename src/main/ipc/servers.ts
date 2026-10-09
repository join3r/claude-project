import type { ServersState } from '../../shared/servers'
import type { IpcRegistrar } from './registrar'

/** DevTool servers (step 5 builds Settings → Servers on it). Changes are also broadcast as `servers-state-changed`. */
export function registerServerHandlers(ipc: IpcRegistrar, deps: { servers: () => { getState(): ServersState } }): void {
  ipc.handle('servers-get-state', [], () => deps.servers().getState())
}

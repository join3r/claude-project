import type { AgentClisReport } from '../../shared/agent-clis'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'

export interface HostAgentsDeps {
  /** `claude`, `codex` and `pi` on this host's login PATH. */
  detect: () => Promise<AgentClisReport>
  /** Run the login shell again (after an installer added to its PATH); answers the new PATH. */
  refreshEnv: () => Promise<{ path: string }>
}

/**
 * The agent CLIs a host has, and a fresh login env after one was installed
 * (plan step 7). The first argument names the host (`local` or a server id)
 * for the desktop's router and is ignored here, as for `server-list-dirs`.
 */
export function registerHostAgentHandlers(ipc: IpcRegistrar, deps: HostAgentsDeps): void {
  ipc.handle('host-agent-clis', [safeId], () => deps.detect())
  ipc.handle('host-refresh-env', [safeId], () => deps.refreshEnv())
}

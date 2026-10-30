import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import type { TokenUsageReport } from '../../shared/token-usage'

export interface TokenUsageIpcDeps {
  /** The project's tokens by day, agent and model; null when its sessions aren't on this host (SSH, shell command). */
  projectUsage: (projectId: string) => Promise<TokenUsageReport | null>
}

/** Token usage per project, read from the agents' session files on the host the project lives on. */
export function registerTokenUsageHandlers(ipc: IpcRegistrar, deps: TokenUsageIpcDeps): void {
  ipc.handle('token-usage-project', [safeId], (_event, projectId) => deps.projectUsage(projectId))
}

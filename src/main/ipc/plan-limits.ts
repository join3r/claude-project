import type { IpcRegistrar } from './registrar'
import type { PlanAccount } from '../../shared/plan-limits'

export interface PlanLimitsIpcDeps {
  accounts: () => PlanAccount[]
}

/** Plan windows per claude.ai login (the status bar); changes come as `plan-limits-changed`. */
export function registerPlanLimitsHandlers(ipc: IpcRegistrar, deps: PlanLimitsIpcDeps): void {
  ipc.handle('plan-limits-get', [], () => deps.accounts())
}

import type { UpdateStatus } from '../../shared/updates'
import type { IpcRegistrar } from './registrar'

/** The part of the updater the IPC surface drives. */
export interface UpdatesControl {
  status(): UpdateStatus
  check(): Promise<UpdateStatus>
  install(): Promise<void>
}

/** Settings → Updates. Status changes are also broadcast as `updates-status`. */
export function registerUpdateHandlers(ipc: IpcRegistrar, deps: { updates: () => UpdatesControl }): void {
  ipc.handle('updates-get-status', [], () => deps.updates().status())
  ipc.handle('updates-check', [], () => deps.updates().check())
  ipc.handle('updates-install', [], () => deps.updates().install())
}

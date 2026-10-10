import type { IpcRegistrar } from './registrar'
import { v } from './validate'

export interface TaskNameIpcDeps {
  /** A short title for a task's first prompt, or null (see `task-namer.ts`). */
  suggest: (prompt: string) => Promise<string | null>
}

/** A window names a task it started from a prompt; the rename itself stays the window's. */
export function registerTaskNameHandlers(ipc: IpcRegistrar, deps: TaskNameIpcDeps): void {
  ipc.handle('task-name-suggest', [v.string({ nonEmpty: true, max: 100_000 })], (_event, prompt) => deps.suggest(prompt))
}

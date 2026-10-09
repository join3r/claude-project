import type { PromptQueueRunner } from '../prompt-queue-runner'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'

export interface PromptQueueIpcDeps {
  promptQueue: PromptQueueRunner
}

/**
 * Project Home's queue (`prompt-queue-runner.ts`). The queue itself is project
 * data the windows edit; only running a prompt is main's, by ids.
 */
export function registerPromptQueueHandlers(ipc: IpcRegistrar, deps: PromptQueueIpcDeps): void {
  ipc.handle('prompt-queue-run', [safeId, safeId], (_event, projectId, itemId) =>
    deps.promptQueue.run(projectId, itemId))
}

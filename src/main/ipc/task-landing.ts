import type { TaskLandingManager } from '../task-landing'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import { v } from './validate'

export interface TaskLandingIpcDeps {
  taskLanding: TaskLandingManager
}

const landOptions = v.object({
  keepWorktree: v.optional(v.boolean())
})

/**
 * Landing a task's worktree into its stream (`task-landing.ts`). Ids only: main
 * looks up the worktrees and branches itself. Every change to `Task.landing`
 * also reaches the windows as `task-landing-state` (taskId, landing | null).
 */
export function registerTaskLandingHandlers(ipc: IpcRegistrar, deps: TaskLandingIpcDeps): void {
  ipc.handle('task-land', [safeId, safeId, v.optional(landOptions)], (_event, projectId, taskId, options) =>
    deps.taskLanding.landTask(projectId, taskId, options ?? {}))

  ipc.handle('task-landing-retry', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.retryLanding(projectId, taskId))

  ipc.handle('task-landing-abort', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.abortLanding(projectId, taskId))

  ipc.handle('task-landing-fix', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.fixWithAgent(projectId, taskId))

  ipc.handle('task-update-from-stream', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.updateFromStream(projectId, taskId))

  ipc.handle('task-stream-ahead', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.streamAhead(projectId, taskId))

  ipc.handle('task-landing-preview', [safeId, safeId], (_event, projectId, taskId) =>
    deps.taskLanding.preview(projectId, taskId))

  ipc.handle('task-worktree-close', [safeId, safeId, v.literal('keep', 'discard')], (_event, projectId, taskId, mode) =>
    deps.taskLanding.closeWorktree(projectId, taskId, mode))
}

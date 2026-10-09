import type { PendingWorktreeSetup } from '../../shared/types'
import type { TaskWorktreeManager } from '../task-worktree'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import { v, type Validator } from './validate'

export interface TaskWorktreeIpcDeps {
  taskWorktrees: TaskWorktreeManager
}

const ensureOptions = v.object({
  name: v.optional(v.string({ max: 1000 })),
  streamId: v.optional(safeId)
})

const pendingSetup = v.object({
  repoKey: v.string({ nonEmpty: true, max: 4096 }),
  hash: v.string({ nonEmpty: true, max: 128 }),
  commands: v.array(v.string())
}) as Validator<PendingWorktreeSetup>

/**
 * Task worktrees (`task-worktree.ts`): a window asks for one before a task's
 * tabs spawn, answers the setup approval, and mirrors every task's state.
 * The ids name tasks and streams main looks up itself; nothing here takes a path.
 */
export function registerTaskWorktreeHandlers(ipc: IpcRegistrar, deps: TaskWorktreeIpcDeps): void {
  ipc.handle('task-worktree-ensure', [safeId, safeId, v.optional(ensureOptions)], (_event, projectId, taskId, options) =>
    deps.taskWorktrees.ensureTaskWorktree(projectId, taskId, options ?? {}))

  ipc.handle('task-worktree-decide', [safeId, v.literal('run', 'skip')], (_event, taskId, decision) =>
    deps.taskWorktrees.decideSetup(taskId, decision))

  ipc.handle('task-worktree-dismiss', [safeId], (_event, taskId) => {
    deps.taskWorktrees.dismiss(taskId)
  })

  ipc.handle('task-worktree-states', [], () => deps.taskWorktrees.getStates())

  ipc.handle('stream-worktree-setup-run', [safeId, safeId, pendingSetup], (_event, projectId, streamId, pending) =>
    deps.taskWorktrees.runStreamSetup(projectId, streamId, pending))
}

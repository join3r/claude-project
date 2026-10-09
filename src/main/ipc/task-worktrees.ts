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
 * A window: `win:<n>` on this machine, or `link:<desktop>:win:<n>` on a DevTool
 * server (a paired desktop's window, through the link). Not desktop main's own
 * calls (`main`), nor anything else that may call a host one day (a phone).
 */
export function isWindowClient(clientId: string): boolean {
  return /^(?:link:[A-Za-z0-9_-]{1,128}:)?win:\d+$/.test(clientId)
}

/**
 * Setup commands come from the repo, so they run only once the user said yes
 * in a window (the task's panel, or the New stream dialog). On a DevTool server
 * the prompt is shown on the desktop and its answer arrives as this call from
 * that window; the approval is then stored here, where the commands run.
 */
function assertApprovedInWindow(clientId: string): void {
  if (!isWindowClient(clientId)) throw new Error('Worktree setup commands are approved from a DevTool window')
}

/**
 * Task worktrees (`task-worktree.ts`): a window asks for one before a task's
 * tabs spawn, answers the setup approval, and mirrors every task's state.
 * The ids name tasks and streams main looks up itself; nothing here takes a path.
 */
export function registerTaskWorktreeHandlers(ipc: IpcRegistrar, deps: TaskWorktreeIpcDeps): void {
  ipc.handle('task-worktree-ensure', [safeId, safeId, v.optional(ensureOptions)], (_event, projectId, taskId, options) =>
    deps.taskWorktrees.ensureTaskWorktree(projectId, taskId, options ?? {}))

  ipc.handle('task-worktree-decide', [safeId, v.literal('run', 'skip')], (ctx, taskId, decision) => {
    if (decision === 'run') assertApprovedInWindow(ctx.clientId)
    return deps.taskWorktrees.decideSetup(taskId, decision)
  })

  ipc.handle('task-worktree-dismiss', [safeId], (_event, taskId) => {
    deps.taskWorktrees.dismiss(taskId)
  })

  ipc.handle('task-worktree-states', [], () => deps.taskWorktrees.getStates())

  ipc.handle('stream-worktree-setup-run', [safeId, safeId, pendingSetup], (ctx, projectId, streamId, pending) => {
    assertApprovedInWindow(ctx.clientId)
    return deps.taskWorktrees.runStreamSetup(projectId, streamId, pending)
  })
}

import type { PtyAttachResult, PtySessions } from '../pty-sessions'
import type { StreamRuns, StreamRunResult } from '../stream-runs'
import type { RunCommandSuggestResult, SuggestedRunCommand } from '../run-command-suggester'
import { parseStreamRunTabId, type StreamRunState } from '../../shared/stream-run'
import type { IpcRegistrar } from './registrar'
import { optSafeId, safeId } from './schemas'
import { v } from './validate'

export interface StreamRunDeps {
  streamRuns: StreamRuns
  ptySessions: PtySessions
  /** Commands `claude` suggests for the project, or a stream when given (`run-command-suggester.ts`). */
  suggestCommands: (projectId: string, streamId: string | undefined, current: SuggestedRunCommand[]) => Promise<RunCommandSuggestResult>
}

const suggestCurrent = v.array(v.object({ name: v.string({ max: 200 }), command: v.string({ max: 4000 }) }), { max: 50 })

export interface StreamRunAttachResult extends PtyAttachResult {
  state: StreamRunState | null
}

/**
 * A stream's command runs (`src/shared/stream-run.ts`): Run (in a task's worktree
 * when given its id), Stop and Restart, and the logs view, which attaches to the
 * run's PTY like a terminal tab but never spawns one. Typing and resizing then go
 * through `pty-write` / `pty-resize`. Suggest asks `claude` for the commands
 * themselves, which the editor shows before anything is saved.
 */
export function registerStreamRunHandlers(ipc: IpcRegistrar, deps: StreamRunDeps): void {
  const { streamRuns, ptySessions } = deps

  ipc.handle('run-commands-suggest', [safeId, optSafeId, suggestCurrent], (_ctx, projectId, streamId, current) =>
    deps.suggestCommands(projectId, streamId, current)
  )

  ipc.handle(
    'stream-run-control',
    [safeId, safeId, safeId, v.literal('start', 'stop', 'restart'), optSafeId],
    (_ctx, projectId, streamId, commandId, action, taskId): Promise<StreamRunResult> =>
      streamRuns.control(projectId, streamId, commandId, action, taskId)
  )

  ipc.handle('stream-run-states', [safeId], (_ctx, projectId) => streamRuns.statesOf(projectId))

  // `tabId` is the run's PTY id (`streamRunTabId`), so routing can pin it to the project's host.
  ipc.handle('stream-run-attach', [safeId, safeId], (ctx, _projectId, tabId): StreamRunAttachResult | null => {
    const parsed = parseStreamRunTabId(tabId)
    if (!parsed) return null
    const attached = ptySessions.attachExisting(ctx.clientId, tabId)
    return attached ? { ...attached, state: streamRuns.state(parsed.streamId, parsed.commandId) } : null
  })

  ipc.on('stream-run-detach', [safeId], (ctx, tabId) => {
    ptySessions.detach(ctx.clientId, tabId)
  })
}

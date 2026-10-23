import type { PtyAttachResult, PtySessions } from '../pty-sessions'
import type { StreamRuns, StreamRunResult } from '../stream-runs'
import { streamIdOfRunTab, type StreamRunState } from '../../shared/stream-run'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import { v } from './validate'

export interface StreamRunDeps {
  streamRuns: StreamRuns
  ptySessions: PtySessions
}

export interface StreamRunAttachResult extends PtyAttachResult {
  state: StreamRunState | null
}

/**
 * A stream's app run (`src/shared/stream-run.ts`): Run, Stop and Restart, and the
 * logs view, which attaches to the run's PTY like a terminal tab but never spawns
 * one. Typing and resizing then go through `pty-write` / `pty-resize`.
 */
export function registerStreamRunHandlers(ipc: IpcRegistrar, deps: StreamRunDeps): void {
  const { streamRuns, ptySessions } = deps

  ipc.handle(
    'stream-run-control',
    [safeId, safeId, v.literal('start', 'stop', 'restart')],
    (_ctx, projectId, streamId, action): Promise<StreamRunResult> => streamRuns.control(projectId, streamId, action)
  )

  ipc.handle('stream-run-states', [safeId], (_ctx, projectId) => streamRuns.statesOf(projectId))

  // `tabId` is the run's PTY id (`streamRunTabId`), so routing can pin it to the project's host.
  ipc.handle('stream-run-attach', [safeId, safeId], (ctx, _projectId, tabId): StreamRunAttachResult | null => {
    const streamId = streamIdOfRunTab(tabId)
    if (!streamId) return null
    const attached = ptySessions.attachExisting(ctx.clientId, tabId)
    return attached ? { ...attached, state: streamRuns.state(streamId) } : null
  })

  ipc.on('stream-run-detach', [safeId], (ctx, tabId) => {
    ptySessions.detach(ctx.clientId, tabId)
  })
}

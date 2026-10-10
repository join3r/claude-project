import { randomUUID } from 'crypto'
import type { ProjectsData, QueuedPrompt } from '../../shared/types'
import { isShellCommandProject } from '../../shared/types'
import { applyPromptQueueOp, promptQueue, type PromptQueueOp } from '../../shared/prompt-queue'
import { findMainStream } from '../../shared/streams'
import { AppErrorCode, type QueueRunParams, type QueueUpdateParams } from '../../../protocol/ts/index.ts'
import { mobileProject, type MobileOutcome } from './new-stream'

/**
 * `queue.update` (SPEC.md §8.16): Project Home's queue edits from the phone, as the
 * same `PromptQueueOp`s a window sends. Unlike a window's replayed updater, the phone
 * hears `not-found` for a prompt or stream that isn't there.
 */

export type QueueUpdateOutcome = MobileOutcome<{ data: ProjectsData; changed: boolean; itemId?: string }>

function notFound(message: string): { ok: false; code: string; message: string } {
  return { ok: false, code: AppErrorCode.NotFound, message }
}

export function updateQueueInData(data: ProjectsData, params: QueueUpdateParams, ids: () => string = randomUUID): QueueUpdateOutcome {
  const found = mobileProject(data, params.projectId)
  if (!found.ok) return found
  const project = found.project
  const hasItem = (id: string): boolean => promptQueue(project).some((item) => item.id === id)
  const hasStream = (id: string): boolean => project.streams.some((stream) => stream.id === id)
  let op: PromptQueueOp
  let itemId: string | undefined
  switch (params.action) {
    case 'add': {
      if (isShellCommandProject(project)) return { ok: false, code: AppErrorCode.Unsupported, message: 'A shell-command project runs one command, not Claude.' }
      if (params.streamId !== undefined && !hasStream(params.streamId)) return notFound('No such stream')
      // As the window adds one: no `streamId` means `main`.
      const main = findMainStream(project)?.id
      const item: QueuedPrompt = { id: ids(), text: params.text, ...(params.streamId && params.streamId !== main ? { streamId: params.streamId } : {}) }
      itemId = item.id
      op = { op: 'add', item }
      break
    }
    case 'edit':
    case 'remove':
    case 'move':
      if (!hasItem(params.itemId)) return notFound('That prompt is no longer queued.')
      op = params.action === 'edit'
        ? { op: 'edit', id: params.itemId, text: params.text }
        : params.action === 'remove'
          ? { op: 'remove', id: params.itemId }
          : { op: 'move', id: params.itemId, toIndex: params.toIndex }
      break
    case 'auto-run':
      if (!hasStream(params.streamId)) return notFound('No such stream')
      op = { op: 'auto-run', streamId: params.streamId, on: params.on }
      break
  }
  const next = applyPromptQueueOp(project, op)
  // `auto-run` copies the stream even when the switch is already as asked.
  const changed = next !== project && JSON.stringify(next) !== JSON.stringify(project)
  const out: QueueUpdateOutcome = {
    ok: true,
    data: changed ? { ...data, projects: data.projects.map((p) => (p.id === project.id ? next : p)) } : data,
    changed
  }
  if (itemId !== undefined) out.itemId = itemId
  return out
}

/** `queue.run`'s checks before the runner: a project the phone sees, and a prompt still queued. */
export function queuedPromptForRun(data: ProjectsData, params: QueueRunParams): MobileOutcome<object> {
  const found = mobileProject(data, params.projectId)
  if (!found.ok) return found
  if (!promptQueue(found.project).some((item) => item.id === params.itemId)) return notFound('That prompt is no longer queued.')
  return { ok: true }
}

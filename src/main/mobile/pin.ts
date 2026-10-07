import { pinnedItemKey, type PinnedItem, type ProjectsData } from '../../shared/types'
import { findStreamOfTask } from '../../shared/streams'
import { AppErrorCode, type PinSetParams } from '../../../protocol/ts/index.ts'
import { isVisibleOnMobile } from './inbox'

/**
 * `pin.set` (SPEC.md §8.10): the phone's Pin / Unpin, as the sidebar's context menu
 * does it. A new pin goes to the end of the list; pinning what is already pinned, or
 * unpinning what isn't, leaves the data as it is.
 *
 * The phone knows no streams yet: it sees a pinned stream as each of its tasks
 * pinned (`buildPinned`). So unpinning a task also drops the pin of the stream
 * holding it, or the task would stay pinned on the phone.
 */

export type PinSetResult =
  | { ok: true; data: ProjectsData; changed: boolean }
  | { ok: false; code: string; message: string }

export function setPinInData(data: ProjectsData, params: PinSetParams): PinSetResult {
  const project = data.projects.find((p) => p.id === params.projectId)
  if (!project || !isVisibleOnMobile(project)) return { ok: false, code: AppErrorCode.NotFound, message: 'No such project' }
  let item: PinnedItem = { type: 'project', projectId: project.id }
  // Pins that show this target as pinned on the phone; unpinning drops all of them.
  const shownBy = new Set<string>()
  if (params.taskId !== undefined) {
    const stream = findStreamOfTask(project, params.taskId)
    const task = stream?.tasks.find((t) => t.id === params.taskId)
    if (!stream || !task) return { ok: false, code: AppErrorCode.NotFound, message: 'No such task' }
    item = { type: 'task', projectId: project.id, streamId: stream.id, taskId: task.id }
    shownBy.add(pinnedItemKey({ type: 'stream', projectId: project.id, streamId: stream.id }))
  }
  const key = pinnedItemKey(item)
  shownBy.add(key)
  const existing = data.pinnedItems ?? []
  const isPinned = existing.some((candidate) => shownBy.has(pinnedItemKey(candidate)))
  if (isPinned === params.pinned) return { ok: true, data, changed: false }
  const pinnedItems = params.pinned ? [...existing, item] : existing.filter((candidate) => !shownBy.has(pinnedItemKey(candidate)))
  return { ok: true, data: { ...data, pinnedItems }, changed: true }
}

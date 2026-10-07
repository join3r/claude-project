import { pinnedItemKey, type PinnedItem, type ProjectsData } from '../../shared/types'
import { findStreamOfTask } from '../../shared/streams'
import { AppErrorCode, type PinSetParams } from '../../../protocol/ts/index.ts'
import { isVisibleOnMobile } from './inbox'

/**
 * `pin.set` (SPEC.md §8.10): the phone's Pin / Unpin of a project, a stream or a
 * task, as the sidebar's context menu does it. A new pin goes to the end of the
 * list; pinning what is already pinned, or unpinning what isn't, leaves the data
 * as it is. A task pin names the stream holding the task now, whatever stream the
 * phone sent.
 */

export type PinSetResult =
  | { ok: true; data: ProjectsData; changed: boolean }
  | { ok: false; code: string; message: string }

export function setPinInData(data: ProjectsData, params: PinSetParams): PinSetResult {
  const project = data.projects.find((p) => p.id === params.projectId)
  if (!project || !isVisibleOnMobile(project)) return { ok: false, code: AppErrorCode.NotFound, message: 'No such project' }
  let item: PinnedItem = { type: 'project', projectId: project.id }
  if (params.taskId !== undefined) {
    const stream = findStreamOfTask(project, params.taskId)
    if (!stream) return { ok: false, code: AppErrorCode.NotFound, message: 'No such task' }
    item = { type: 'task', projectId: project.id, streamId: stream.id, taskId: params.taskId }
  } else if (params.streamId !== undefined) {
    if (!project.streams.some((stream) => stream.id === params.streamId)) {
      return { ok: false, code: AppErrorCode.NotFound, message: 'No such stream' }
    }
    item = { type: 'stream', projectId: project.id, streamId: params.streamId }
  }
  const key = pinnedItemKey(item)
  const existing = data.pinnedItems ?? []
  const isPinned = existing.some((candidate) => pinnedItemKey(candidate) === key)
  if (isPinned === params.pinned) return { ok: true, data, changed: false }
  const pinnedItems = params.pinned ? [...existing, item] : existing.filter((candidate) => pinnedItemKey(candidate) !== key)
  return { ok: true, data: { ...data, pinnedItems }, changed: true }
}

import { isHomeTask, type ProjectsData, type Task, type TaskInboxState } from '../../shared/types'
import { isSettled, isSnoozed, isUnread } from '../../shared/inbox-state'
import {
  inboxSettled,
  inboxSnoozed,
  inboxUnread,
  inboxUnsettled,
  inboxUnsnoozed,
  inboxVisited
} from '../../shared/inbox-transitions'
import { AppErrorCode, type TaskTriageParams } from '../../../protocol/ts/index.ts'
import { findTaskInProject, mapTaskInProject } from '../../shared/streams'
import { isVisibleOnMobile } from './inbox'

/**
 * `task.triage` (SPEC.md §8.11): the inbox's row actions from the phone, through the
 * same transitions the window uses. An action that would not change what either
 * inbox shows leaves the data as it is, so a phone re-sending `read` costs no commit.
 */

export type TaskTriageResult =
  | { ok: true; data: ProjectsData; changed: boolean }
  | { ok: false; code: string; message: string }

/** The task's next triage state, or null when the action changes nothing visible. */
function nextInbox(task: Task, params: TaskTriageParams, now: number): TaskInboxState | null {
  const inbox = task.inbox ?? {}
  switch (params.action) {
    case 'read':
      return isUnread(task) ? inboxVisited(inbox, now) : null
    case 'unread':
      return isUnread(task) ? null : inboxUnread(inbox)
    case 'settle':
      return inboxSettled(inbox, now)
    case 'unsettle':
      return isSettled(task) ? inboxUnsettled(inbox) : null
    case 'snooze':
      return inboxSnoozed(inbox, now, params.untilAttention ? { untilAttention: true } : { until: params.until })
    case 'unsnooze':
      return isSnoozed(task, now) ? inboxUnsnoozed(inbox) : null
  }
}

export function triageTaskInData(data: ProjectsData, params: TaskTriageParams, now: number): TaskTriageResult {
  for (const project of data.projects) {
    const task = findTaskInProject(project, params.taskId)
    if (!task) continue
    if (!isVisibleOnMobile(project) || isHomeTask(task)) break
    const inbox = nextInbox(task, params, now)
    if (!inbox) return { ok: true, data, changed: false }
    const next: ProjectsData = {
      ...data,
      projects: data.projects.map((p) =>
        p !== project ? p : mapTaskInProject(p, task.id, (t) => ({ ...t, inbox }))
      )
    }
    return { ok: true, data: next, changed: true }
  }
  return { ok: false, code: AppErrorCode.NotFound, message: 'No such task' }
}

import { useCallback, useRef } from 'react'
import type { TaskInboxState } from '../../../shared/types'
import { createInteractionStampGate } from '../../components/taskRecency'
import type { AppStateCore } from './useAppStateCore'
import { mapTask } from './projectsData'
import {
  inboxSettled,
  inboxSnoozed,
  inboxUnread,
  inboxUnsettled,
  inboxUnsnoozed,
  inboxVisited,
  inboxWithEvent,
  type SnoozeOptions,
  type TaskEventKind
} from './inbox'

export interface TaskInboxActions {
  markTaskInteracted: (projectId: string, taskId: string) => void
  markTaskEvent: (projectId: string, taskId: string, kind?: TaskEventKind) => void
  markTaskVisited: (projectId: string, taskId: string) => void
  markTaskUnread: (projectId: string, taskId: string) => void
  settleTask: (projectId: string, taskId: string) => void
  unsettleTask: (projectId: string, taskId: string) => void
  snoozeTask: (projectId: string, taskId: string, options: SnoozeOptions) => void
  unsnoozeTask: (projectId: string, taskId: string) => void
}

/** Task recency and inbox triage: interaction stamps, events, read/unread, settle and snooze. */
export function useTaskInbox(core: AppStateCore): TaskInboxActions {
  const { mutateProjects, windowViewStateRef } = core
  const interactionGateRef = useRef(createInteractionStampGate())

  const markTaskInteracted = useCallback((projectId: string, taskId: string) => {
    const now = Date.now()
    if (!interactionGateRef.current(taskId, now)) return
    mutateProjects(prev => mapTask(prev, projectId, taskId, task => ({ ...task, lastInteractedAt: now })))
  }, [mutateProjects])

  const updateTaskInbox = useCallback((
    projectId: string,
    taskId: string,
    updater: (inbox: TaskInboxState) => TaskInboxState
  ) => {
    mutateProjects(prev => mapTask(prev, projectId, taskId, task => ({ ...task, inbox: updater(task.inbox ?? {}) })))
  }, [mutateProjects])

  const markTaskEvent = useCallback((
    projectId: string,
    taskId: string,
    kind: TaskEventKind = 'event'
  ) => {
    const now = Date.now()
    // An event in the task you are currently looking at is read on arrival —
    // otherwise the row you are staring at goes bold and stays that way.
    const watching = windowViewStateRef.current.selectedTaskId === taskId
    updateTaskInbox(projectId, taskId, inbox => inboxWithEvent(inbox, now, kind, watching))
  }, [updateTaskInbox])

  const markTaskVisited = useCallback((projectId: string, taskId: string) => {
    updateTaskInbox(projectId, taskId, inbox => inboxVisited(inbox, Date.now()))
  }, [updateTaskInbox])

  const markTaskUnread = useCallback((projectId: string, taskId: string) => {
    updateTaskInbox(projectId, taskId, inboxUnread)
  }, [updateTaskInbox])

  const settleTask = useCallback((projectId: string, taskId: string) => {
    const now = Date.now()
    updateTaskInbox(projectId, taskId, inbox => inboxSettled(inbox, now))
  }, [updateTaskInbox])

  const unsettleTask = useCallback((projectId: string, taskId: string) => {
    updateTaskInbox(projectId, taskId, inboxUnsettled)
  }, [updateTaskInbox])

  const snoozeTask = useCallback((projectId: string, taskId: string, options: SnoozeOptions) => {
    const now = Date.now()
    updateTaskInbox(projectId, taskId, inbox => inboxSnoozed(inbox, now, options))
  }, [updateTaskInbox])

  const unsnoozeTask = useCallback((projectId: string, taskId: string) => {
    updateTaskInbox(projectId, taskId, inboxUnsnoozed)
  }, [updateTaskInbox])

  return {
    markTaskInteracted,
    markTaskEvent,
    markTaskVisited,
    markTaskUnread,
    settleTask,
    unsettleTask,
    snoozeTask,
    unsnoozeTask
  }
}

/**
 * Settle and snooze that also leave the task when this window is looking at it:
 * the task drops into a group the Inbox may keep folded, so it should not stay
 * open with nothing in the sidebar marking it. The window goes to the project's
 * Home. Only this window's own actions do this; a triage from the phone or
 * another window leaves the view alone.
 */
export function useLeaveOnPutAway(
  core: AppStateCore,
  inbox: Pick<TaskInboxActions, 'settleTask' | 'snoozeTask'>,
  selectProjectHome: (projectId: string) => void
): Pick<TaskInboxActions, 'settleTask' | 'snoozeTask'> {
  const { windowViewStateRef } = core
  const { settleTask: settle, snoozeTask: snooze } = inbox

  const leaveIfSelected = useCallback((projectId: string, taskId: string) => {
    if (windowViewStateRef.current.selectedTaskId === taskId) selectProjectHome(projectId)
  }, [windowViewStateRef, selectProjectHome])

  const settleTask = useCallback((projectId: string, taskId: string) => {
    settle(projectId, taskId)
    leaveIfSelected(projectId, taskId)
  }, [settle, leaveIfSelected])

  const snoozeTask = useCallback((projectId: string, taskId: string, options: SnoozeOptions) => {
    snooze(projectId, taskId, options)
    leaveIfSelected(projectId, taskId)
  }, [snooze, leaveIfSelected])

  return { settleTask, snoozeTask }
}

import { useCallback, useRef } from 'react'
import type { TaskInboxState } from '../../../shared/types'
import { createInteractionStampGate } from '../../components/taskRecency'
import type { AppStateCore } from './useAppStateCore'
import { mapTask } from './projectsData'
import { findTaskInProject } from '../../../shared/streams'
import {
  inboxSnoozed,
  inboxUnread,
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
  /** Keep the agent's last answer on the task (`TaskInboxState.preview`); a no-op when unchanged. */
  setTaskPreview: (projectId: string, taskId: string, preview: string) => void
  snoozeTask: (projectId: string, taskId: string, options: SnoozeOptions) => void
  unsnoozeTask: (projectId: string, taskId: string) => void
  /** Take the task off Autopilot (`Task.autopilot` goes): it is yours from here, like any task. */
  endAutopilot: (projectId: string, taskId: string) => void
}

/** Task recency and inbox triage: interaction stamps, events, read/unread and snooze. */
export function useTaskInbox(core: AppStateCore): TaskInboxActions {
  const { mutateProjects, windowViewStateRef, projectsRef } = core
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

  const setTaskPreview = useCallback((projectId: string, taskId: string, preview: string) => {
    // Unchanged leaves the data alone: every window sees the same answer, and a no-op must not save.
    const current = findTaskInProject(projectsRef.current.find(p => p.id === projectId), taskId)
    if (!current || current.inbox?.preview === preview) return
    mutateProjects(prev => {
      const task = findTaskInProject(prev.projects.find(p => p.id === projectId), taskId)
      if (!task || task.inbox?.preview === preview) return prev
      return mapTask(prev, projectId, taskId, t => ({ ...t, inbox: { ...t.inbox, preview } }))
    })
  }, [mutateProjects])

  const snoozeTask = useCallback((projectId: string, taskId: string, options: SnoozeOptions) => {
    const now = Date.now()
    updateTaskInbox(projectId, taskId, inbox => inboxSnoozed(inbox, now, options))
  }, [updateTaskInbox])

  const unsnoozeTask = useCallback((projectId: string, taskId: string) => {
    updateTaskInbox(projectId, taskId, inboxUnsnoozed)
  }, [updateTaskInbox])

  const endAutopilot = useCallback((projectId: string, taskId: string) => {
    mutateProjects(prev => mapTask(prev, projectId, taskId, task => {
      if (!task.autopilot) return task
      const { autopilot: _autopilot, ...rest } = task
      return rest
    }))
  }, [mutateProjects])

  return {
    endAutopilot,
    markTaskInteracted,
    markTaskEvent,
    markTaskVisited,
    markTaskUnread,
    setTaskPreview,
    snoozeTask,
    unsnoozeTask
  }
}

/**
 * Snooze that also leaves the task when this window is looking at it: the
 * task drops into a group the Inbox keeps folded, so it should not stay
 * open with nothing in the sidebar marking it. The window goes to the project's
 * Home. Only this window's own actions do this; a triage from the phone or
 * another window leaves the view alone.
 */
export function useLeaveOnPutAway(
  core: AppStateCore,
  inbox: Pick<TaskInboxActions, 'snoozeTask'>,
  selectProjectHome: (projectId: string) => void
): Pick<TaskInboxActions, 'snoozeTask'> {
  const { windowViewStateRef } = core
  const { snoozeTask: snooze } = inbox

  const leaveIfSelected = useCallback((projectId: string, taskId: string) => {
    if (windowViewStateRef.current.selectedTaskId === taskId) selectProjectHome(projectId)
  }, [windowViewStateRef, selectProjectHome])

  const snoozeTask = useCallback((projectId: string, taskId: string, options: SnoozeOptions) => {
    snooze(projectId, taskId, options)
    leaveIfSelected(projectId, taskId)
  }, [snooze, leaveIfSelected])

  return { snoozeTask }
}

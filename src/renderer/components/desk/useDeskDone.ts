import { useCallback, useRef } from 'react'
import { useApp } from '../../context/AppContext'
import { useTabStatusStore } from '../../context/TabStatusContext'
import { isChatTabType, isEphemeralProject } from '../../../shared/types'
import type { Project, Task, TaskLandingResult } from '../../../shared/types'
import { findStreamOfTask, findTaskInProject, taskTabs } from '../../../shared/streams'
import { tabIdsOfTask } from '../../hooks/appState/projectsData'
import { canLandTask, getLandingOp, markTaskClosing, runLandingOp, setLandingNotice } from '../../taskLanding'
import { landingResultNotice } from '../useTaskLandingActions'
import { isTaskWorking } from '../sidebar/closeRules'
import { useAllAgentActivity } from '../../agentActivity'
import type { AgentActivity } from '../../../shared/agent-activity'
import { taskBackground, type TaskBackground } from './deskInbox'

const STOP_WAIT_MS = 15_000
/** After stopping background work: how long to let the agent settle before landing anyway. */
const SETTLE_MS = 5_000

/**
 * Tasks a Done is under way for, in this window: a second click, or E pressed
 * again while the first waits on a confirm or the agent stopping, is dropped
 * instead of landing twice.
 */
const inFlight = new Set<string>()

/** Stop every task of a Background state (■ Stop, and Done before it lands). Best-effort. */
export async function stopBackground(background: TaskBackground): Promise<void> {
  await Promise.all(background.tasks.map(task => window.api.chatStopTask(background.tabId, task.id).catch(() => false)))
}

/**
 * The desk's ✓ Done (decision 4 of the redesign): one click lands the task's
 * worktree into its stream, removes it and archives the task. No three-way
 * question. A conflict is handed to the task's agent straight away; main
 * retries the landing when the agent's turn ends (`TaskLandingManager.fixWithAgent`),
 * and a second conflict leaves the task in Needs you. A blocked stream goes to
 * Needs you directly. A task without a worktree of its own just closes. A busy
 * agent is stopped first, after a confirm; so is work left running in the
 * background (a dev server, a build), whose turn already ended.
 *
 * `fallback` handles what this doesn't: the last task of an ad-hoc project,
 * which takes the project's worktrees with it (`useCloseTask`).
 *
 * `how` is Done's ▾: `keep` closes without landing and keeps the branch,
 * `discard` throws the worktree and branch away (the caller asked). Both stop
 * the agent the same way first. Done of any kind takes the task off Autopilot
 * first, so main doesn't land it a second time when the stopped turn ends.
 */
export type DeskDoneHow = 'land' | 'keep' | 'discard'

export function useDeskDone(fallback: (projectId: string, taskId: string) => Promise<void>): (projectId: string, taskId: string, how?: DeskDoneHow) => Promise<void> {
  const { projects, archiveTask, confirmDiscardDirty, endAutopilot } = useApp()
  const tabStatusStore = useTabStatusStore()
  const activities = useAllAgentActivity()
  const activitiesRef = useRef<Record<string, AgentActivity>>(activities)
  activitiesRef.current = activities

  /** Interrupts the task's working chat tabs and waits for them to go quiet. False when one can't be stopped. */
  const stopAgents = useCallback(async (task: Task): Promise<boolean> => {
    const working = taskTabs(task).filter(tab => tabStatusStore.getStatus(tab.id) === 'working')
    if (working.some(tab => !isChatTabType(tab.type))) {
      window.alert(`"${task.name}" has an agent running in a terminal. Stop it there, then mark the task done.`)
      return false
    }
    await Promise.all(working.map(tab => window.api.chatInterrupt(tab.id).catch(() => {})))
    const deadline = Date.now() + STOP_WAIT_MS
    while (Date.now() < deadline) {
      if (!working.some(tab => tabStatusStore.getStatus(tab.id) === 'working')) return true
      await new Promise(resolve => window.setTimeout(resolve, 250))
    }
    window.alert(`The agent in "${task.name}" didn't stop. Try again in a moment.`)
    return false
  }, [tabStatusStore])

  /**
   * Stops the background work, then gives the agent a moment: a stopped task's
   * notification can start a turn, which is interrupted. Landing tears the
   * session down regardless, so this never blocks Done.
   */
  const stopInBackground = useCallback(async (background: TaskBackground): Promise<void> => {
    await stopBackground(background)
    const deadline = Date.now() + SETTLE_MS
    let interrupted = false
    while (Date.now() < deadline && tabStatusStore.getStatus(background.tabId) === 'working') {
      if (!interrupted && activitiesRef.current[background.tabId]?.turnStartedAt !== undefined) {
        interrupted = true
        await window.api.chatInterrupt(background.tabId).catch(() => {})
      }
      await new Promise(resolve => window.setTimeout(resolve, 250))
    }
  }, [tabStatusStore])

  const finish = useCallback(async (projectId: string, taskId: string, how: DeskDoneHow) => {
    const project: Project | undefined = projects.find(p => p.id === projectId)
    const task = findTaskInProject(project, taskId)
    if (!project || !task) return
    if (isEphemeralProject(project)) return fallback(projectId, taskId)
    const stream = findStreamOfTask(project, taskId)
    if (!stream) return

    if (task.landing?.state === 'landing' || task.landing?.state === 'fixing' || getLandingOp(task.id)) return
    const verb = how === 'land' ? 'land' : how === 'keep' ? 'close' : 'discard'
    if (isTaskWorking(task, (tabId) => tabStatusStore.getStatus(tabId))) {
      const background = taskBackground(task, activitiesRef.current)
      if (background) {
        if (!window.confirm(`"${task.name}" still has work running in the background (${background.label}). Stop it and ${verb}?`)) return
        if (task.autopilot) endAutopilot(projectId, taskId)
        await stopInBackground(background)
      } else {
        if (!window.confirm(`The agent in "${task.name}" is still working. Stop it and ${verb}?`)) return
        if (task.autopilot) endAutopilot(projectId, taskId)
        if (!await stopAgents(task)) return
      }
    } else if (task.autopilot && task.autopilot.phase !== 'stopped') {
      endAutopilot(projectId, taskId)
    }
    if (how !== 'discard' && await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return

    if (!canLandTask(project, task)) {
      void archiveTask(projectId, taskId, { dirtyChecked: how === 'discard' })
      return
    }

    const release = markTaskClosing(task.id)
    try {
      if (how !== 'land') {
        const mode = how === 'keep' ? 'keep' : 'discard'
        const closed = await runLandingOp(task.id, mode, () => window.api.taskWorktreeClose(project.id, task.id, mode))
        if (closed.status === 'removed') return
        const notice = landingResultNotice(closed, 'close', stream.name)
        if (notice) setLandingNotice(task.id, notice)
        return
      }
      // A landing already stopped on a conflict resumes through the agent; anything else lands afresh.
      let result: TaskLandingResult = task.landing?.state === 'conflict'
        ? { status: 'conflict', files: task.landing.files ?? [] }
        : await runLandingOp(task.id, 'close', () => window.api.taskLand(project.id, task.id))
      if (result.status === 'conflict') {
        result = await runLandingOp(task.id, 'fix', () => window.api.taskLandingFix(project.id, task.id))
      }
      if (result.status === 'landed' || result.status === 'nothing' || result.status === 'removed' || result.status === 'fixing') return
      const notice = landingResultNotice(result, 'close', stream.name)
      if (notice) setLandingNotice(task.id, notice)
    } finally {
      release()
    }
  }, [projects, fallback, tabStatusStore, stopAgents, stopInBackground, confirmDiscardDirty, archiveTask, endAutopilot])

  return useCallback(async (projectId: string, taskId: string, how: DeskDoneHow = 'land') => {
    if (inFlight.has(taskId)) return
    inFlight.add(taskId)
    try {
      await finish(projectId, taskId, how)
    } finally {
      inFlight.delete(taskId)
    }
  }, [finish])
}

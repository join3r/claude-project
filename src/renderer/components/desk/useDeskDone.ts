import { useCallback } from 'react'
import { useApp } from '../../context/AppContext'
import { useTabStatusStore } from '../../context/TabStatusContext'
import { isEphemeralProject } from '../../../shared/types'
import type { Project, Task, TaskLandingResult } from '../../../shared/types'
import { findStreamOfTask, findTaskInProject, taskTabs } from '../../../shared/streams'
import { tabIdsOfTask } from '../../hooks/appState/projectsData'
import { canLandTask, getLandingOp, markTaskClosing, runLandingOp, setLandingNotice } from '../../taskLanding'
import { landingResultNotice } from '../useTaskLandingActions'
import { isTaskWorking } from '../sidebar/closeRules'

const STOP_WAIT_MS = 15_000

/**
 * The desk's ✓ Done (decision 4 of the redesign): one click lands the task's
 * worktree into its stream, removes it and archives the task. No three-way
 * question. A conflict is handed to the task's agent straight away; main
 * retries the landing when the agent's turn ends (`TaskLandingManager.fixWithAgent`),
 * and a second conflict leaves the task in Needs you. A blocked stream goes to
 * Needs you directly. A task without a worktree of its own just closes. A busy
 * agent is stopped first, after a confirm.
 *
 * `fallback` handles what this doesn't: the last task of an ad-hoc project,
 * which takes the project's worktrees with it (`useCloseTask`).
 */
export function useDeskDone(fallback: (projectId: string, taskId: string) => Promise<void>): (projectId: string, taskId: string) => Promise<void> {
  const { projects, archiveTask, confirmDiscardDirty } = useApp()
  const tabStatusStore = useTabStatusStore()

  /** Interrupts the task's working chat tabs and waits for them to go quiet. False when one can't be stopped. */
  const stopAgents = useCallback(async (task: Task): Promise<boolean> => {
    const working = taskTabs(task).filter(tab => tabStatusStore.getStatus(tab.id) === 'working')
    if (working.some(tab => tab.type !== 'claude-chat')) {
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

  return useCallback(async (projectId: string, taskId: string) => {
    const project: Project | undefined = projects.find(p => p.id === projectId)
    const task = findTaskInProject(project, taskId)
    if (!project || !task) return
    if (isEphemeralProject(project)) return fallback(projectId, taskId)
    const stream = findStreamOfTask(project, taskId)
    if (!stream) return

    if (task.landing?.state === 'landing' || task.landing?.state === 'fixing' || getLandingOp(task.id)) return
    if (isTaskWorking(task, (tabId) => tabStatusStore.getStatus(tabId))) {
      if (!window.confirm(`The agent in "${task.name}" is still working. Stop it and mark the task done?`)) return
      if (!await stopAgents(task)) return
    }
    if (await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return

    if (!canLandTask(project, task)) {
      void archiveTask(projectId, taskId)
      return
    }

    const release = markTaskClosing(task.id)
    try {
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
  }, [projects, fallback, tabStatusStore, stopAgents, confirmDiscardDirty, archiveTask])
}

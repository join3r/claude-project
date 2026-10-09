import { useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { findStreamOfTask, findTaskInProject } from '../../shared/streams'
import type { Project, Task, TaskLandingResult } from '../../shared/types'
import { tabIdsOfTask } from '../hooks/appState/projectsData'
import {
  markTaskClosing,
  refreshStreamAhead,
  runLandingOp,
  setLandingNotice,
  type LandingNotice,
  type LandingOp
} from '../taskLanding'

/**
 * The line a landing call leaves on the task's banner, or null when the
 * banner already shows the outcome (a stopped landing is on `Task.landing`)
 * or there is nothing to say.
 */
export function landingResultNotice(result: TaskLandingResult, op: LandingOp, streamName: string): LandingNotice | null {
  switch (result.status) {
    case 'landed':
      return { tone: 'info', text: `Landed into ${streamName}.` }
    case 'updated':
      return { tone: 'info', text: `Updated from ${streamName}.` }
    case 'nothing':
      return { tone: 'info', text: op === 'update' ? `Already up to date with ${streamName}.` : `Nothing to land into ${streamName}.` }
    case 'working':
      return { tone: 'error', text: 'The agent is working. Try again once it stops.' }
    case 'failed':
      return { tone: 'error', text: result.error }
    default:
      return null
  }
}

/**
 * The landing actions of a task that has a worktree of its own: the task
 * menu's Land and Update from stream, and the banner's Ask agent to fix /
 * I'll fix it / Retry / Abort. Results show on the task's banner; a stop
 * selects the task so its banner is on screen.
 */
export function useTaskLandingActions(): {
  land: (project: Project, task: Task) => Promise<void>
  update: (project: Project, task: Task) => Promise<void>
  retry: (project: Project, task: Task) => Promise<void>
  abort: (project: Project, task: Task) => Promise<void>
  fix: (project: Project, task: Task) => Promise<void>
  fixByHand: (project: Project, task: Task) => void
} {
  const { switchToTask, archiveTask, addTab, confirmDiscardDirty, projects } = useApp()

  const settle = useCallback((project: Project, task: Task, op: LandingOp, result: TaskLandingResult) => {
    const streamName = findStreamOfTask(project, task.id)?.name ?? 'the stream'
    setLandingNotice(task.id, landingResultNotice(result, op, streamName))
    refreshStreamAhead(project.id, task.id)
    if (result.status === 'conflict' || result.status === 'blocked' || result.status === 'failed') switchToTask(project.id, task.id)
  }, [switchToTask])

  const run = useCallback(async (project: Project, task: Task, op: LandingOp, call: () => Promise<TaskLandingResult>) => {
    settle(project, task, op, await runLandingOp(task.id, op, call))
  }, [settle])

  const land = useCallback((project: Project, task: Task) =>
    run(project, task, 'land', () => window.api.taskLand(project.id, task.id, { keepWorktree: true })), [run])

  const update = useCallback((project: Project, task: Task) =>
    run(project, task, 'update', () => window.api.taskUpdateFromStream(project.id, task.id)), [run])

  const abort = useCallback((project: Project, task: Task) =>
    run(project, task, 'abort', () => window.api.taskLandingAbort(project.id, task.id)), [run])

  const fix = useCallback((project: Project, task: Task) =>
    run(project, task, 'fix', () => window.api.taskLandingFix(project.id, task.id)), [run])

  /** Picks the stopped landing up again; a close that lands now archives the task, as closing would have. */
  const retry = useCallback(async (project: Project, task: Task) => {
    const closing = (task.landing?.intent ?? 'close') === 'close'
    if (closing && await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return
    const release = closing ? markTaskClosing(task.id) : null
    try {
      const result = await runLandingOp(task.id, 'retry', () => window.api.taskLandingRetry(project.id, task.id))
      if (closing && (result.status === 'landed' || result.status === 'nothing')) {
        await archiveTask(project.id, task.id, { dirtyChecked: true })
        return
      }
      settle(project, task, 'retry', result)
    } finally {
      release?.()
    }
  }, [archiveTask, confirmDiscardDirty, settle])

  /** A terminal at the task's worktree root, where the rebase stopped. */
  const fixByHand = useCallback((project: Project, task: Task) => {
    const current = findTaskInProject(projects.find(p => p.id === project.id), task.id) ?? task
    const root = current.workspace?.worktreePath
    if (!root) return
    addTab(project.id, task.id, 'focused', 'terminal', { cwd: root })
  }, [addTab, projects])

  return { land, update, retry, abort, fix, fixByHand }
}

import React, { useCallback, useRef } from 'react'
import { useApp } from '../../context/AppContext'
import { useTabStatusStore } from '../../context/TabStatusContext'
import type { Project, TaskLandingResult } from '../../../shared/types'
import { findTaskInProject } from '../../../shared/streams'
import { tabIdsOfTask } from '../../hooks/appState/projectsData'
import { canLandTask, getLandingOp, markTaskClosing, runLandingOp, setLandingNotice } from '../../taskLanding'
import { landingResultNotice } from '../useTaskLandingActions'
import { confirmWorktreeRemoval, forceRemoveWorktree } from './workspaceRemoval'
import { isTaskWorking, streamCloseQuestion, streamTasksCloseQuestion, type StreamTaskCheck } from './closeRules'
import { useStreamTasksChoice, useWorktreeChoice, type StreamTasksChoice } from './WorktreeChoiceDialog'

/** How long to wait for main's archive of a landed task to reach this window. */
const LANDED_WAIT_MS = 2000

/**
 * Close a stream (never `main`): it is archived with its tasks to the
 * project's `Done` group. Asks when a task is working (unsaved editors are
 * asked about before anything lands or goes).
 *
 * Tasks with worktrees of their own come first. When any of them has work not
 * landed, one question lists them (`streamTasksCloseQuestion`):
 *  - Land all, then close: each lands in the stream's order and main archives
 *    it; the first conflict, blocked stream or failure stops there, selects
 *    that task and leaves the stream open.
 *  - Keep branches: each worktree goes, its branch stays.
 *  - Discard all: worktrees and branches go.
 * Tasks with nothing to land just lose their worktree. Either way a task that
 * stays with the stream keeps `Task.workspace` as the record a reopen
 * restores (or replaces, when the branch went).
 *
 * Then the stream's own worktree runs its pre-flight: clean and merged goes
 * quietly (its branch too, unless the tasks kept theirs, which branch off it),
 * anything else asks keep branch / discard / cancel.
 */
export function useCloseStream(): {
  closeStream: (projectId: string, streamId: string) => Promise<void>
  dialog: React.ReactElement | null
} {
  const { projects, archiveStream, confirmDiscardDirty, switchToTask } = useApp()
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const tabStatusStore = useTabStatusStore()
  const worktreeChoice = useWorktreeChoice()
  const askWorktree = worktreeChoice.ask
  const tasksChoice = useStreamTasksChoice()
  const askTasks = tasksChoice.ask

  /** Main archived these tasks; resolves once this window's projects have caught up (or after a while). */
  const landedGone = useCallback(async (projectId: string, taskIds: string[]) => {
    const deadline = Date.now() + LANDED_WAIT_MS
    const live = () => taskIds.some(taskId => findTaskInProject(projectsRef.current.find(p => p.id === projectId), taskId))
    while (live() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  }, [])

  const closeStream = useCallback(async (projectId: string, streamId: string) => {
    const project = projects.find(p => p.id === projectId)
    const stream = project?.streams.find(candidate => candidate.id === streamId)
    if (!project || !stream || stream.isMain) return
    const statusOf = (tabId: string) => tabStatusStore.getStatus(tabId)
    const question = streamCloseQuestion(stream, statusOf)
    if (question && !window.confirm(question)) return

    const own = stream.tasks.filter(task => canLandTask(project, task))
    const busy = own.find(task => task.landing?.state === 'landing' || getLandingOp(task.id))
    if (busy) {
      window.alert(`"${busy.name}" is landing into ${stream.name}. Close the stream once that has finished.`)
      return
    }
    const checks: StreamTaskCheck[] = await Promise.all(own.map(async task => ({
      task,
      working: isTaskWorking(task, statusOf),
      preview: await window.api.taskLandingPreview(project.id, task.id).catch(() => null)
    })))
    const tasksQuestion = streamTasksCloseQuestion(stream, checks)
    let choice: StreamTasksChoice | null = null
    if (tasksQuestion) {
      choice = await askTasks(tasksQuestion)
      if (choice === 'cancel') return
    }
    const withWork = new Set(tasksQuestion?.tasks.map(entry => entry.taskId) ?? [])
    // Before anything lands or goes: a Save is what gets landed.
    if (await confirmDiscardDirty(stream.tasks.flatMap(tabIdsOfTask)) === 'cancel') return

    const releases: (() => void)[] = []
    try {
      if (choice === 'land') {
        const landed: string[] = []
        for (const task of own.filter(candidate => withWork.has(candidate.id))) {
          releases.push(markTaskClosing(task.id))
          const result: TaskLandingResult = await runLandingOp(task.id, 'close', () => window.api.taskLand(project.id, task.id))
          if (result.status === 'landed' || result.status === 'nothing') {
            landed.push(task.id)
            continue
          }
          setLandingNotice(task.id, landingResultNotice(result, 'close', stream.name))
          switchToTask(project.id, task.id)
          return
        }
        await landedGone(project.id, landed)
      }

      // After landing, which moved the stream's branch. Kept task branches need theirs to come back on.
      const workspace = stream.workspace
      const answer = workspace
        ? await confirmWorktreeRemoval(project, stream.name, workspace, askWorktree, { keepBranch: choice === 'keep-branch' })
        : { done: true as const }
      if (!answer) return

      const failures = await removeTaskWorktrees(project, own.filter(task => choice !== 'land' || !withWork.has(task.id)), taskId => (
        choice === 'keep-branch' && withWork.has(taskId) ? 'keep' : 'discard'
      ), releases)
      if (failures.length > 0) {
        // Each record stays on its task: a reopen finds the worktree still registered, or restores it.
        window.alert(`Some task worktrees could not be removed and were left on disk:\n\n${failures.join('\n')}`)
      }

      // Tabs end in the archive, before the forced removal, so no process holds the worktree.
      if (!await archiveStream(projectId, streamId, true, { dirtyChecked: true })) return
      if (workspace && !answer.done) await forceRemoveWorktree(project, workspace, answer.keepBranch)
    } finally {
      releases.forEach(release => release())
    }
  }, [projects, tabStatusStore, askTasks, askWorktree, confirmDiscardDirty, switchToTask, archiveStream, landedGone])

  return {
    closeStream,
    dialog: (
      <>
        {worktreeChoice.dialog}
        {tasksChoice.dialog}
      </>
    )
  }
}

/**
 * The worktrees of tasks that stay with their closing stream: main stops each
 * task's tabs and removes its worktree (keeping or deleting the branch), and
 * leaves `Task.workspace` on the task as the record of it. Returns what failed.
 */
async function removeTaskWorktrees(
  project: Project,
  tasks: readonly { id: string; name: string }[],
  modeOf: (taskId: string) => 'keep' | 'discard',
  releases: (() => void)[]
): Promise<string[]> {
  const failures: string[] = []
  for (const task of tasks) {
    const mode = modeOf(task.id)
    releases.push(markTaskClosing(task.id))
    const result = await runLandingOp(task.id, mode, () => window.api.taskWorktreeClose(project.id, task.id, mode, { archive: false }))
    if (result.status !== 'removed') failures.push(`"${task.name}": ${result.status === 'failed' ? result.error : result.status}`)
  }
  return failures
}

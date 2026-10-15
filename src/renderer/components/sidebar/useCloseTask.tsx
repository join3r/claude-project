import React, { useCallback } from 'react'
import { useApp } from '../../context/AppContext'
import { useTabStatusStore } from '../../context/TabStatusContext'
import { isEphemeralProject } from '../../../shared/types'
import type { Project, Task, TaskLandingResult } from '../../../shared/types'
import { findStreamOfTask, findTaskInProject, projectTasks } from '../../../shared/streams'
import { tabIdsOfTask } from '../../hooks/appState/projectsData'
import { canLandTask, getLandingOp, markTaskClosing, runLandingOp, setLandingNotice } from '../../taskLanding'
import { landingResultNotice } from '../useTaskLandingActions'
import { confirmWorktreeRemoval, forceRemoveWorktree } from './workspaceRemoval'
import { isTaskWorking, taskCloseQuestion, taskLandingCloseQuestion, taskRemoveQuestion } from './closeRules'
import { useWorktreeChoice } from './WorktreeChoiceDialog'
import { useTaskCloseChoice, type TaskCloseChoice } from './TaskCloseDialog'

/**
 * Close a task: it is archived to its stream's `Done (N)`. Asks only when its
 * agent is working (unsaved editors ask in `archiveTask`); its stream stays, even
 * emptied. The sidebar's rows and the task header both close through this, and
 * each renders the returned `dialog` (the worktree questions below).
 *
 * A task with a worktree of its own lands into its stream first (see
 * `taskLandingCloseQuestion`); main then stops its tabs, removes the worktree
 * and archives it. A landing that stops on a conflict or a blocked stream
 * keeps the task open and selects it, where its banner says what next.
 *
 * `removeTask` is the Inbox row's ✕: a task with a worktree of its own asks
 * once, then its worktree and branch go without landing (uncommitted work with
 * them) and it is archived. Any other task has nothing of its own to throw
 * away, so it just closes.
 */
export function useCloseTask(): {
  closeTask: (projectId: string, taskId: string) => Promise<void>
  removeTask: (projectId: string, taskId: string) => Promise<void>
  dialog: React.ReactElement | null
} {
  const { projects, archiveTask, confirmDiscardDirty, switchToTask } = useApp()
  const tabStatusStore = useTabStatusStore()
  const worktreeChoice = useWorktreeChoice()
  const ask = worktreeChoice.ask
  const closeChoice = useTaskCloseChoice()
  const askClose = closeChoice.ask

  /**
   * Lands the task (or keeps / discards its branch, as asked); main archives
   * it. False when it stays open: cancelled, stopped, or failed. `discard`
   * skips the question: the caller already asked.
   */
  const landAndArchive = useCallback(async (project: Project, task: Task, discard = false): Promise<boolean> => {
    const stream = findStreamOfTask(project, task.id)
    if (!stream) return false
    if (task.landing?.state === 'landing' || getLandingOp(task.id)) {
      window.alert(`"${task.name}" is landing into ${stream.name}. Close it once that has finished.`)
      return false
    }
    let choice: TaskCloseChoice = 'discard'
    if (!discard) {
      const working = isTaskWorking(task, (tabId) => tabStatusStore.getStatus(tabId))
      // Only worth asking main when the answer could change the question.
      const preview = working || task.landing
        ? null
        : await window.api.taskLandingPreview(project.id, task.id).catch(() => null)
      const question = taskLandingCloseQuestion(task, stream.name, preview, working)
      choice = question ? await askClose(question) : 'land'
      if (choice === 'cancel') return false
    }
    // Before landing: a Save is what gets landed. A removal already said its work goes.
    if (!discard && await confirmDiscardDirty(tabIdsOfTask(task)) === 'cancel') return false

    const release = markTaskClosing(task.id)
    try {
      let result: TaskLandingResult
      if (choice === 'land') {
        result = await runLandingOp(task.id, 'close', () => window.api.taskLand(project.id, task.id))
      } else {
        const mode = choice === 'keep-branch' ? 'keep' : 'discard'
        result = await runLandingOp(task.id, mode, () => window.api.taskWorktreeClose(project.id, task.id, mode))
      }
      if (result.status === 'landed' || result.status === 'nothing' || result.status === 'removed') return true
      setLandingNotice(task.id, landingResultNotice(result, 'close', stream.name))
      switchToTask(project.id, task.id)
      return false
    } finally {
      release()
    }
  }, [askClose, confirmDiscardDirty, switchToTask, tabStatusStore])

  const closeOrRemove = useCallback(async (projectId: string, taskId: string, remove: boolean) => {
    const project = projects.find(p => p.id === projectId)
    const task = findTaskInProject(project, taskId)
    if (!project || !task) return
    const lands = canLandTask(project, task)
    if (lands && remove) {
      if (!window.confirm(taskRemoveQuestion(task))) return
    } else if (!lands) {
      const question = taskCloseQuestion(task, (tabId) => tabStatusStore.getStatus(tabId))
      if (question && !window.confirm(question)) return
    }
    // The last task of a hidden ad-hoc project takes the project with it, and any
    // worktree stream it still has: that gets the stream's pre-flight first.
    const retiring = isEphemeralProject(project) && projectTasks(project).every(candidate => candidate.id === taskId)
    const worktrees = retiring ? project.streams.filter(stream => stream.workspace) : []
    if (worktrees.length === 0) {
      if (lands) await landAndArchive(project, task, remove)
      else void archiveTask(projectId, taskId)
      return
    }
    const answers = []
    for (const stream of worktrees) {
      const answer = await confirmWorktreeRemoval(project, stream.name, stream.workspace!, ask)
      if (!answer) return
      answers.push({ stream, answer })
    }
    if (lands ? !await landAndArchive(project, task, remove) : !await archiveTask(projectId, taskId)) return
    for (const { stream, answer } of answers) {
      if (!answer.done) await forceRemoveWorktree(project, stream.workspace!, answer.keepBranch)
    }
  }, [projects, archiveTask, tabStatusStore, ask, landAndArchive])

  const closeTask = useCallback((projectId: string, taskId: string) => closeOrRemove(projectId, taskId, false), [closeOrRemove])
  const removeTask = useCallback((projectId: string, taskId: string) => closeOrRemove(projectId, taskId, true), [closeOrRemove])

  return {
    closeTask,
    removeTask,
    dialog: (
      <>
        {worktreeChoice.dialog}
        {closeChoice.dialog}
      </>
    )
  }
}

import React, { useCallback } from 'react'
import { useApp } from '../../context/AppContext'
import { useTabStatusStore } from '../../context/TabStatusContext'
import { isEphemeralProject } from '../../../shared/types'
import { findTaskInProject, projectTasks } from '../../../shared/streams'
import { confirmWorktreeRemoval, forceRemoveWorktree } from './workspaceRemoval'
import { taskCloseQuestion } from './closeRules'
import { useWorktreeChoice } from './WorktreeChoiceDialog'

/**
 * Close a task: it is archived to its stream's `Done (N)`. Asks only when its
 * agent is working (unsaved editors ask in `archiveTask`); its stream stays, even
 * emptied. The sidebar's rows and the task header both close through this, and
 * each renders the returned `dialog` (the worktree question below).
 */
export function useCloseTask(): {
  closeTask: (projectId: string, taskId: string) => Promise<void>
  dialog: React.ReactElement | null
} {
  const { projects, archiveTask } = useApp()
  const tabStatusStore = useTabStatusStore()
  const worktreeChoice = useWorktreeChoice()
  const ask = worktreeChoice.ask

  const closeTask = useCallback(async (projectId: string, taskId: string) => {
    const project = projects.find(p => p.id === projectId)
    const task = findTaskInProject(project, taskId)
    if (!project || !task) return
    const question = taskCloseQuestion(task, (tabId) => tabStatusStore.getStatus(tabId))
    if (question && !window.confirm(question)) return
    // The last task of a hidden ad-hoc project takes the project with it, and any
    // worktree stream it still has: that gets the stream's pre-flight first.
    const retiring = isEphemeralProject(project) && projectTasks(project).every(candidate => candidate.id === taskId)
    const worktrees = retiring ? project.streams.filter(stream => stream.workspace) : []
    if (worktrees.length === 0) {
      void archiveTask(projectId, taskId)
      return
    }
    const answers = []
    for (const stream of worktrees) {
      const answer = await confirmWorktreeRemoval(project, stream.name, stream.workspace!, ask)
      if (!answer) return
      answers.push({ stream, answer })
    }
    if (!await archiveTask(projectId, taskId)) return
    for (const { stream, answer } of answers) {
      if (!answer.done) await forceRemoveWorktree(project, stream.workspace!, answer.keepBranch)
    }
  }, [projects, archiveTask, tabStatusStore, ask])

  return { closeTask, dialog: worktreeChoice.dialog }
}

import { useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { NEW_TASK_NAME } from '../../shared/types'
import {
  currentStreamId, findTaskInProject, needsTaskWorktree, runsInTaskDir, streamDirectory, taskDirectory,
  taskMoveBlocker, taskTabs
} from '../../shared/streams'

/**
 * An empty task in `streamId`, or in the project's current stream (the one this
 * window is in, else the one last worked in, else `main`). No inline rename:
 * the task opens on its prompt box, and the first prompt names it. Its project
 * and stream open in the tree so switching to it doesn't hide the new row.
 */
export function useAddEmptyTask(): (projectId: string, streamId?: string) => void {
  const { projects, selectedTaskId, addTask, setProjectExpanded, setStreamExpanded } = useApp()
  return useCallback((projectId: string, streamId?: string) => {
    const project = projects.find(p => p.id === projectId)
    if (!project) return
    const target = streamId ?? currentStreamId(project, selectedTaskId)
    addTask(projectId, NEW_TASK_NAME, [], target)
    setProjectExpanded(projectId, true)
    if (target) setStreamExpanded(target, true)
  }, [projects, selectedTaskId, addTask, setProjectExpanded, setStreamExpanded])
}

/**
 * Move a task to a place in another (or its own) stream: the tree's drag and
 * drop, and the menus' "Move to stream". Into a stream with another folder it
 * asks first: the task's agent and terminals start again over there. A task
 * with its own worktree stays in its stream (it says why).
 */
export function useMoveTask(): (projectId: string, taskId: string, toStreamId: string, toIndex?: number) => void {
  const { projects, moveTask } = useApp()
  return useCallback((projectId: string, taskId: string, toStreamId: string, toIndex?: number) => {
    const project = projects.find(p => p.id === projectId)
    const from = project?.streams.find(stream => stream.tasks.some(task => task.id === taskId))
    const to = project?.streams.find(stream => stream.id === toStreamId)
    const task = findTaskInProject(project, taskId)
    if (!project || !from || !to || !task) return
    const blocked = taskMoveBlocker(task, from, to)
    if (blocked) {
      window.alert(blocked)
      return
    }
    const restart = from !== to && taskDirectory(project, task) !== streamDirectory(project, to)
    if (restart) {
      const where = needsTaskWorktree(project, to, task)
        ? `a worktree of its own, branched from ${to.workspace!.branchName}`
        : to.workspace ? `the ${to.workspace.branchName} worktree` : 'the project folder'
      const lines = [`Move "${task.name}" to ${to.name}?`, `It will work in ${where}.`]
      if (taskTabs(task).some(runsInTaskDir)) lines.push('Its agent and terminals restart there.')
      if (!window.confirm(lines.join('\n\n'))) return
    }
    void moveTask(projectId, taskId, toStreamId, toIndex ?? to.tasks.length, { restart })
  }, [projects, moveTask])
}

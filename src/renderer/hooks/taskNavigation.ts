// src/renderer/hooks/taskNavigation.ts
import type { Project } from '../../shared/types'
import { findTaskInProject, projectLastTaskId, projectTasks } from '../../shared/streams'

/**
 * Which task should we land on inside `project`?
 *
 * Mirrors `resolveStoredSelection` in src/shared/types.ts: a requested task
 * wins when it actually belongs to the project, otherwise the project's own
 * last-selected task, otherwise its home task. `preferredTaskId` is allowed to
 * be stale or to belong to a different project — that is exactly the case this
 * helper exists to absorb.
 */
export function resolveLandingTaskId(
  project: Project | null | undefined,
  preferredTaskId?: string | null
): string | null {
  if (!project) return null
  const belongs = (id: string | null | undefined): boolean =>
    !!findTaskInProject(project, id)

  if (belongs(preferredTaskId)) return preferredTaskId!
  const lastTaskId = projectLastTaskId(project)
  if (lastTaskId) return lastTaskId
  const tasks = projectTasks(project)
  const homeTask = tasks.find(task => task.system === 'home')
  if (homeTask) return homeTask.id
  return tasks[0]?.id ?? null
}

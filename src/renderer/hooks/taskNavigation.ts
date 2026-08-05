// src/renderer/hooks/taskNavigation.ts
import type { Project } from '../../shared/types'

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
    !!id && project.tasks.some(task => task.id === id)

  if (belongs(preferredTaskId)) return preferredTaskId!
  if (belongs(project.lastTaskId)) return project.lastTaskId!
  const homeTask = project.tasks.find(task => task.system === 'home')
  if (homeTask) return homeTask.id
  return project.tasks[0]?.id ?? null
}

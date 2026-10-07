// src/renderer/hooks/taskNavigation.ts
import type { Project } from '../../shared/types'
import { findTaskInProject } from '../../shared/streams'

/**
 * Which task a tab opened from `project`'s Home page lands in.
 *
 * A requested task wins when it actually belongs to the project. Otherwise the
 * `main` stream's task it was last left on, else its first task: Home works in the
 * project folder, and `main` is the stream that does too. Null when `main` is
 * empty. `preferredTaskId` is allowed to be stale or to belong to a different
 * project — that is exactly the case this helper exists to absorb.
 */
export function resolveLandingTaskId(
  project: Project | null | undefined,
  preferredTaskId?: string | null
): string | null {
  if (!project) return null
  if (preferredTaskId && findTaskInProject(project, preferredTaskId)) return preferredTaskId
  const main = project.streams.find(stream => stream.isMain)
  if (!main) return null
  if (main.lastTaskId && main.tasks.some(task => task.id === main.lastTaskId)) return main.lastTaskId
  return main.tasks[0]?.id ?? null
}

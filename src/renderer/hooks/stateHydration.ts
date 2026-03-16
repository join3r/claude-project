import type { AppConfig, Project } from '../../shared/types'

export type StateUpdater<T> = (prev: T) => T

export function applyQueuedStateUpdates<T>(baseState: T, updaters: StateUpdater<T>[]): T {
  return updaters.reduce((state, updater) => updater(state), baseState)
}

export function resolveInitialSelection(
  projects: Project[],
  config: AppConfig,
  currentProjectId: string | null,
  currentTaskId: string | null
): { projectId: string | null; taskId: string | null } {
  if (currentProjectId !== null) {
    return { projectId: currentProjectId, taskId: currentTaskId }
  }

  if (!config.lastProjectId) {
    return { projectId: currentProjectId, taskId: currentTaskId }
  }

  const project = projects.find((candidate) => candidate.id === config.lastProjectId)
  if (!project) {
    return { projectId: currentProjectId, taskId: currentTaskId }
  }

  const candidateTaskId = config.lastTaskId ?? project.lastTaskId ?? null
  const taskId = currentTaskId === null && candidateTaskId && project.tasks.some((task) => task.id === candidateTaskId)
    ? candidateTaskId
    : currentTaskId

  return { projectId: config.lastProjectId, taskId }
}

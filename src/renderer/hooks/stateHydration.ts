import type { AppConfig, Project, ProjectsData } from '../../shared/types'

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

export function persistSelectionState(
  projectsData: ProjectsData,
  config: AppConfig,
  selectedProjectId: string | null,
  selectedTaskId: string | null
): { projectsData: ProjectsData; config: AppConfig } {
  const nextConfig = config.lastProjectId === selectedProjectId && config.lastTaskId === selectedTaskId
    ? config
    : {
        ...config,
        lastProjectId: selectedProjectId,
        lastTaskId: selectedTaskId
      }

  if (!selectedProjectId || !selectedTaskId) {
    return { projectsData, config: nextConfig }
  }

  const project = projectsData.projects.find((candidate) => candidate.id === selectedProjectId)
  if (!project || !project.tasks.some((task) => task.id === selectedTaskId) || project.lastTaskId === selectedTaskId) {
    return { projectsData, config: nextConfig }
  }

  return {
    config: nextConfig,
    projectsData: {
      ...projectsData,
      projects: projectsData.projects.map((candidate) => (
        candidate.id === selectedProjectId
          ? { ...candidate, lastTaskId: selectedTaskId }
          : candidate
      ))
    }
  }
}

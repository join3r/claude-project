import type { Project, ProjectNote } from '../../shared/types'

export function backfillLifetimeStats(
  project: Project,
  notes: Record<string, ProjectNote[]>
): Project {
  if (project.lifetimeStats) return project
  return {
    ...project,
    lifetimeStats: {
      tasksCreated: project.tasks.length,
      notesCreated: (notes[project.id] ?? []).length
    }
  }
}

export function incrementLifetimeStat(
  project: Project,
  field: 'tasksCreated' | 'notesCreated'
): Project {
  const current = project.lifetimeStats ?? { tasksCreated: 0, notesCreated: 0 }
  return {
    ...project,
    lifetimeStats: { ...current, [field]: current[field] + 1 }
  }
}

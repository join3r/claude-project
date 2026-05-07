// src/renderer/palette/sources/projects.ts
import type { AppActions } from '../../hooks/useAppState'
import type { PaletteEntity } from '../types'

export function projectsToEntities(actions: AppActions): PaletteEntity[] {
  return actions.projects.map(p => ({
    kind: 'project' as const,
    id: `project:${p.id}`,
    title: p.name,
    subtitle: p.emoji ?? undefined,
    searchable: p.name
  }))
}

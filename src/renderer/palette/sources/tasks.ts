// src/renderer/palette/sources/tasks.ts
import type { AppActions } from '../../hooks/useAppState'
import type { PaletteEntity } from '../types'

export function tasksToEntities(actions: AppActions, opts: { allProjects: boolean }): PaletteEntity[] {
  const out: PaletteEntity[] = []
  const activeId = actions.selectedProjectId
  for (const p of actions.projects) {
    if (!opts.allProjects && p.id !== activeId) continue
    for (const t of p.tasks) {
      if (t.system === 'home') continue
      out.push({
        kind: 'task',
        id: `task:${p.id}:${t.id}`,
        title: t.name,
        subtitle: opts.allProjects ? p.name : undefined,
        searchable: t.name,
        scopeProjectId: p.id
      })
    }
  }
  return out
}

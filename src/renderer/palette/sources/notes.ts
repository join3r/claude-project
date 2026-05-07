// src/renderer/palette/sources/notes.ts
import type { AppActions } from '../../hooks/useAppState'
import type { PaletteEntity } from '../types'

function excerpt(content: string, max = 80): string {
  const trimmed = content.replace(/\s+/g, ' ').trim()
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + '…'
}

export function notesToEntities(actions: AppActions, opts: { allProjects: boolean }): PaletteEntity[] {
  const out: PaletteEntity[] = []
  const activeId = actions.selectedProjectId
  const projectName = (id: string) => actions.projects.find(p => p.id === id)?.name ?? id

  for (const [projectId, list] of Object.entries(actions.notes)) {
    if (!opts.allProjects && projectId !== activeId) continue
    for (const n of list) {
      out.push({
        kind: 'note',
        id: `note:${projectId}:${n.id}`,
        title: n.name,
        subtitle: opts.allProjects ? projectName(projectId) : undefined,
        searchable: `${n.name} ${excerpt(n.content)}`,
        scopeProjectId: projectId
      })
    }
  }
  return out
}

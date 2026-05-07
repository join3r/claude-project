// src/renderer/palette/sources/openTabs.ts
import type { AppActions } from '../../hooks/useAppState'
import type { PaletteEntity } from '../types'

export function openTabsToEntities(actions: AppActions, opts: { allProjects: boolean }): PaletteEntity[] {
  const out: PaletteEntity[] = []
  const activeId = actions.selectedProjectId
  for (const p of actions.projects) {
    if (!opts.allProjects && p.id !== activeId) continue
    for (const t of p.tasks) {
      for (const pane of ['left', 'right'] as const) {
        for (const tab of t.tabs[pane]) {
          out.push({
            kind: 'tab',
            id: `tab:${p.id}:${t.id}:${pane}:${tab.id}`,
            title: tab.title,
            subtitle: `${t.name} · ${pane}`,
            searchable: `${tab.title} ${t.name}`,
            scopeProjectId: p.id
          })
        }
      }
    }
  }
  return out
}

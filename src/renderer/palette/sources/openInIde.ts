import type { AppActions } from '../../hooks/useAppState'
import { localProjectFolder, paletteAliasesForEditor } from '../../../shared/external-editors'
import type { PaletteEntity } from '../types'
import { desktopPlatform } from '../../hostPlatform'
import { findTaskInProject } from '../../../shared/streams'

export function openInIdeToEntities(actions: AppActions): PaletteEntity[] {
  const editors = actions.config?.externalEditors?.editors ?? []
  if (editors.length === 0) return []
  const project = actions.projects.find((p) => p.id === actions.selectedProjectId)
  const task = findTaskInProject(project, actions.selectedTaskId)
  if (!localProjectFolder(project, task ?? null, desktopPlatform())) return []
  return editors.map((editor) => {
    const title = `Open in ${editor.name || 'editor'}`
    return {
      kind: 'command' as const,
      id: `command:open-ide:${editor.id}`,
      title,
      searchable: [title, ...paletteAliasesForEditor(editor.name)].join(' ')
    }
  })
}

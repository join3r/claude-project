import type { AppActions } from '../hooks/useAppState'
import { commandRegistry } from './CommandRegistry'
import { openInIdeToEntities } from './sources/openInIde'
import type { PaletteEntity } from './types'
import { formatShortcutForApp } from '../../shared/shortcut-label'
import { localProjectFolder } from '../../shared/external-editors'
import { findTaskInProject } from '../../shared/streams'
import { openWorkspaceInIde } from '../openWorkspaceInIde'
import { desktopPlatform } from '../hostPlatform'
import './sources/commands' // side-effect: register commands

/** The commands the palette (and the desk's ⌘K bar) offers right now: the registry's and Open in <IDE>. */
export function paletteCommandEntities(actions: AppActions): PaletteEntity[] {
  return [
    ...commandRegistry.getAvailable({ actions }).map(c => ({
      kind: 'command' as const,
      id: `command:${c.id}`,
      title: c.title,
      searchable: [c.title, ...(c.aliases ?? [])].join(' '),
      shortcut: c.shortcut ? formatShortcutForApp(c.shortcut) : undefined
    })),
    ...openInIdeToEntities(actions)
  ]
}

/** Run a command entity by its id (`command:<id>`). */
export function runPaletteCommand(id: string, actions: AppActions): void {
  const cmdId = id.slice('command:'.length)
  if (cmdId.startsWith('open-ide:')) {
    const editorId = cmdId.slice('open-ide:'.length)
    const project = actions.projects.find(p => p.id === actions.selectedProjectId)
    const task = findTaskInProject(project, actions.selectedTaskId)
    const folder = localProjectFolder(project, task ?? null, desktopPlatform())
    if (folder) void openWorkspaceInIde(editorId, folder, project?.id, project?.host)
    return
  }
  const cmd = commandRegistry.getById(cmdId)
  if (cmd) Promise.resolve(cmd.run({ actions })).catch(() => {})
}

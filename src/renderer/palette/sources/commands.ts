// src/renderer/palette/sources/commands.ts
import { commandRegistry } from '../CommandRegistry'
import { paletteEvents } from '../paletteEvents'
import { AI_TAB_TYPES, AI_TAB_META, isShellCommandProject, type AiTabType } from '../../../shared/types'

const ENABLE_FLAG: Record<AiTabType, 'enableClaude' | 'enableCodex' | 'enableOpencode'> = {
  claude: 'enableClaude',
  codex: 'enableCodex',
  opencode: 'enableOpencode'
}

commandRegistry.register({
  id: 'cmd.openSettings',
  title: 'Open Settings',
  aliases: ['settings', 'prefs'],
  shortcut: '⌘,',
  run: () => paletteEvents.emit('open-settings')
})

commandRegistry.register({
  id: 'cmd.openProjectSettings',
  title: 'Open Project Settings',
  aliases: ['project settings'],
  when: ctx => !!ctx.actions.selectedProjectId,
  run: () => paletteEvents.emit('open-project-settings')
})

commandRegistry.register({
  id: 'cmd.newTerminalTab',
  title: 'New Terminal Tab',
  aliases: ['terminal', 'term'],
  when: ctx => !!ctx.actions.selectedProjectId && !!ctx.actions.selectedTaskId,
  run: ctx => {
    const { selectedProjectId, selectedTaskId } = ctx.actions
    if (!selectedProjectId || !selectedTaskId) return
    ctx.actions.addTab(selectedProjectId, selectedTaskId, 'left', 'terminal')
  }
})

commandRegistry.register({
  id: 'cmd.newEditorTab',
  title: 'New Editor Tab',
  aliases: ['editor', 'edit'],
  when: ctx => !!ctx.actions.selectedProjectId && !!ctx.actions.selectedTaskId,
  run: ctx => {
    const { selectedProjectId, selectedTaskId } = ctx.actions
    if (!selectedProjectId || !selectedTaskId) return
    ctx.actions.addTab(selectedProjectId, selectedTaskId, 'left', 'editor')
  }
})

commandRegistry.register({
  id: 'cmd.newBrowserTab',
  title: 'New Browser Tab',
  aliases: ['browser', 'web'],
  when: ctx => !!ctx.actions.selectedProjectId && !!ctx.actions.selectedTaskId,
  run: ctx => {
    const { selectedProjectId, selectedTaskId } = ctx.actions
    if (!selectedProjectId || !selectedTaskId) return
    ctx.actions.addTab(selectedProjectId, selectedTaskId, 'left', 'browser')
  }
})

for (const aiType of AI_TAB_TYPES) {
  const meta = AI_TAB_META[aiType as AiTabType]
  commandRegistry.register({
    id: `cmd.new${aiType.charAt(0).toUpperCase()}${aiType.slice(1)}Tab`,
    title: `New ${meta.label} Tab`,
    aliases: [meta.label.toLowerCase(), aiType, meta.command],
    when: ctx => {
      const { selectedProjectId, selectedTaskId, projects, config } = ctx.actions
      if (!selectedProjectId || !selectedTaskId) return false
      if (!config?.[ENABLE_FLAG[aiType as AiTabType]]) return false
      const project = projects.find(p => p.id === selectedProjectId)
      if (!project || isShellCommandProject(project)) return false
      return true
    },
    run: ctx => {
      const { selectedProjectId, selectedTaskId } = ctx.actions
      if (!selectedProjectId || !selectedTaskId) return
      ctx.actions.addTab(selectedProjectId, selectedTaskId, 'left', aiType)
    }
  })
}

commandRegistry.register({
  id: 'cmd.newNote',
  title: 'New Note',
  aliases: ['note'],
  when: ctx => !!ctx.actions.selectedProjectId,
  run: ctx => {
    if (ctx.actions.selectedProjectId) ctx.actions.createNote(ctx.actions.selectedProjectId, 'Untitled')
  }
})

commandRegistry.register({
  id: 'cmd.toggleSidebar',
  title: 'Toggle Sidebar',
  aliases: ['sidebar'],
  run: () => paletteEvents.emit('toggle-sidebar')
})

commandRegistry.register({
  id: 'cmd.toggleFileBrowser',
  title: 'Toggle File Browser',
  aliases: ['files', 'browser panel'],
  run: () => paletteEvents.emit('toggle-file-browser')
})

commandRegistry.register({
  id: 'cmd.switchTheme',
  title: 'Switch Theme',
  aliases: ['theme', 'dark', 'light'],
  run: ctx => {
    const next = ctx.actions.effectiveTheme === 'dark' ? 'light' : 'dark'
    ctx.actions.updateConfig({ theme: next })
  }
})

commandRegistry.register({
  id: 'cmd.reloadWindow',
  title: 'Reload Window',
  aliases: ['reload'],
  run: () => paletteEvents.emit('reload-window')
})

commandRegistry.register({
  id: 'cmd.openDevTools',
  title: 'Open DevTools',
  aliases: ['devtools', 'inspect'],
  run: () => paletteEvents.emit('open-devtools')
})

commandRegistry.register({
  id: 'cmd.searchAllProjects',
  title: 'Search All Projects',
  aliases: ['expand', '* expand'],
  run: () => paletteEvents.emit('palette-prefix-set', '*')
})

commandRegistry.register({
  id: 'cmd.quit',
  title: 'Quit DevTool',
  aliases: ['quit', 'exit'],
  run: () => paletteEvents.emit('quit-app')
})

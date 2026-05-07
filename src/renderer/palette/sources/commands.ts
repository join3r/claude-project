// src/renderer/palette/sources/commands.ts
import { commandRegistry } from '../CommandRegistry'
import { paletteEvents } from '../paletteEvents'

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

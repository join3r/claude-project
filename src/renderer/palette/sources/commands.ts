// src/renderer/palette/sources/commands.ts
import { commandRegistry } from '../CommandRegistry'
import { paletteEvents } from '../paletteEvents'
import { AI_TAB_TYPES, AI_TAB_META, isShellCommandProject, type AiTabType } from '../../../shared/types'
import { isPinnable } from '../../components/terminalStatus'

function activePinnableTab(actions: any): { projectId: string; taskId: string; pane: 'left' | 'right'; tabId: string; pinned: boolean } | null {
  const { selectedProjectId, selectedTaskId, projects } = actions
  if (!selectedProjectId || !selectedTaskId) return null
  const project = projects.find((p: any) => p.id === selectedProjectId)
  const task = project?.tasks.find((t: any) => t.id === selectedTaskId)
  if (!task) return null
  const taskState = actions.getTaskViewState(task)
  const pane: 'left' | 'right' = taskState.activeTab.right ? 'right' : 'left'
  const tabId = taskState.activeTab[pane]
  if (!tabId) return null
  const tab = task.tabs[pane].find((x: any) => x.id === tabId)
  if (!tab || !isPinnable(tab)) return null
  return { projectId: selectedProjectId, taskId: selectedTaskId, pane, tabId, pinned: !!tab.pinned }
}

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
  id: 'cmd.openProjectHome',
  title: 'Open Project Home',
  aliases: ['home', 'project home'],
  when: ctx => !!ctx.actions.selectedProjectId,
  run: ctx => {
    if (ctx.actions.selectedProjectId) ctx.actions.setSelectedTaskId(null)
  }
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

commandRegistry.register({
  id: 'cmd.toggleWatchStrip',
  title: 'Toggle Watch Strip',
  aliases: ['watch', 'pin strip', 'watch strip'],
  when: ctx => !!ctx.actions.selectedProjectId,
  run: ctx => {
    if (ctx.actions.selectedProjectId) {
      ctx.actions.toggleWatchStripForProject(ctx.actions.selectedProjectId)
    }
  }
})

commandRegistry.register({
  id: 'cmd.pinActiveTab',
  title: 'Pin Active Tab to Watch Strip',
  aliases: ['pin tab', 'pin watch'],
  when: ctx => {
    const t = activePinnableTab(ctx.actions)
    return !!t && !t.pinned
  },
  run: ctx => {
    const t = activePinnableTab(ctx.actions)
    if (t) ctx.actions.setTabPinned(t.projectId, t.taskId, t.pane, t.tabId, true)
  }
})

commandRegistry.register({
  id: 'cmd.unpinActiveTab',
  title: 'Unpin Active Tab',
  aliases: ['unpin tab', 'unpin watch'],
  when: ctx => {
    const t = activePinnableTab(ctx.actions)
    return !!t && t.pinned
  },
  run: ctx => {
    const t = activePinnableTab(ctx.actions)
    if (t) ctx.actions.setTabPinned(t.projectId, t.taskId, t.pane, t.tabId, false)
  }
})

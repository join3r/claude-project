// src/renderer/palette/sources/commands.ts
import { commandRegistry } from '../CommandRegistry'
import { paletteEvents } from '../paletteEvents'
import { AI_TAB_TYPES, AI_TAB_META, isHomeTask, isShellCommandProject, pinnedItemKey, type AiTabType, type PinnedItem } from '../../../shared/types'

function currentPinTargets(actions: any): { project: PinnedItem | null; task: PinnedItem | null; isPinned: (item: PinnedItem) => boolean } {
  const { selectedProjectId, selectedTaskId, projects, pinnedItems } = actions
  const keys = new Set(((pinnedItems ?? []) as PinnedItem[]).map(pinnedItemKey))
  const isPinned = (item: PinnedItem) => keys.has(pinnedItemKey(item))
  const project = projects.find((p: any) => p.id === selectedProjectId)
  const projectTarget: PinnedItem | null = project ? { type: 'project', projectId: project.id } : null
  const task = project?.tasks.find((t: any) => t.id === selectedTaskId)
  const taskTarget: PinnedItem | null = task && !isHomeTask(task)
    ? { type: 'task', projectId: project.id, taskId: task.id }
    : null
  return { project: projectTarget, task: taskTarget, isPinned }
}

const ENABLE_FLAG: Record<AiTabType, 'enableClaude' | 'enableCodex' | 'enablePi'> = {
  claude: 'enableClaude',
  codex: 'enableCodex',
  pi: 'enablePi'
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
  id: 'cmd.pinCurrentProject',
  title: 'Pin Current Project',
  aliases: ['pin project'],
  when: ctx => {
    const { project, isPinned } = currentPinTargets(ctx.actions)
    return !!project && !isPinned(project)
  },
  run: ctx => {
    const { project, isPinned } = currentPinTargets(ctx.actions)
    if (project && !isPinned(project)) ctx.actions.togglePinnedItem(project)
  }
})

commandRegistry.register({
  id: 'cmd.unpinCurrentProject',
  title: 'Unpin Current Project',
  aliases: ['unpin project'],
  when: ctx => {
    const { project, isPinned } = currentPinTargets(ctx.actions)
    return !!project && isPinned(project)
  },
  run: ctx => {
    const { project, isPinned } = currentPinTargets(ctx.actions)
    if (project && isPinned(project)) ctx.actions.togglePinnedItem(project)
  }
})

commandRegistry.register({
  id: 'cmd.pinCurrentTask',
  title: 'Pin Current Task',
  aliases: ['pin task'],
  when: ctx => {
    const { task, isPinned } = currentPinTargets(ctx.actions)
    return !!task && !isPinned(task)
  },
  run: ctx => {
    const { task, isPinned } = currentPinTargets(ctx.actions)
    if (task && !isPinned(task)) ctx.actions.togglePinnedItem(task)
  }
})

commandRegistry.register({
  id: 'cmd.unpinCurrentTask',
  title: 'Unpin Current Task',
  aliases: ['unpin task'],
  when: ctx => {
    const { task, isPinned } = currentPinTargets(ctx.actions)
    return !!task && isPinned(task)
  },
  run: ctx => {
    const { task, isPinned } = currentPinTargets(ctx.actions)
    if (task && isPinned(task)) ctx.actions.togglePinnedItem(task)
  }
})


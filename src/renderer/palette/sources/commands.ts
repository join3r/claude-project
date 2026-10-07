// src/renderer/palette/sources/commands.ts
import { commandRegistry } from '../CommandRegistry'
import type { AppCtx } from '../types'
import { getPaletteReturnFocus, paletteEvents } from '../paletteEvents'
import { AI_TAB_TYPES, AI_TAB_META, isHomeTask, isShellCommandProject, pinnedItemKey, type AiTabType, type PinnedItem } from '../../../shared/types'
import { shortcutPlatform } from '../../../shared/shortcut-label'
import { claudeTabType } from '../../components/newTaskTabs'
import { findStreamOfTask, findTaskInProject, taskTabs } from '../../../shared/streams'

function currentPinTargets(actions: any): { project: PinnedItem | null; task: PinnedItem | null; isPinned: (item: PinnedItem) => boolean } {
  const { selectedProjectId, selectedTaskId, projects, pinnedItems } = actions
  const keys = new Set(((pinnedItems ?? []) as PinnedItem[]).map(pinnedItemKey))
  const isPinned = (item: PinnedItem) => keys.has(pinnedItemKey(item))
  const project = projects.find((p: any) => p.id === selectedProjectId)
  const projectTarget: PinnedItem | null = project ? { type: 'project', projectId: project.id } : null
  const task = findTaskInProject(project, selectedTaskId)
  const stream = findStreamOfTask(project, selectedTaskId)
  const taskTarget: PinnedItem | null = task && stream && !isHomeTask(task)
    ? { type: 'task', projectId: project.id, streamId: stream.id, taskId: task.id }
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
  // Menu binds Cmd+, on macOS only — do not claim Ctrl+, on Windows.
  shortcut: shortcutPlatform() === 'darwin' ? 'Command+,' : undefined,
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
  shortcut: 'CmdOrCtrl+T',
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
  // Claude opens in the mode Settings picks (terminal or chat), like the tab-bar
  // button, so its entry is named for neither.
  const isClaude = aiType === 'claude'
  commandRegistry.register({
    id: `cmd.new${aiType.charAt(0).toUpperCase()}${aiType.slice(1)}Tab`,
    title: isClaude ? 'New Claude Tab' : `New ${meta.label} Tab`,
    aliases: [meta.label.toLowerCase(), aiType, meta.command, ...(isClaude ? ['claude chat', 'claude code'] : [])],
    when: ctx => {
      const { selectedProjectId, selectedTaskId, projects, config } = ctx.actions
      if (!selectedProjectId || !selectedTaskId) return false
      if (!config?.[ENABLE_FLAG[aiType as AiTabType]]) return false
      const project = projects.find(p => p.id === selectedProjectId)
      if (!project || isShellCommandProject(project)) return false
      return true
    },
    run: ctx => {
      const { selectedProjectId, selectedTaskId, config } = ctx.actions
      if (!selectedProjectId || !selectedTaskId) return
      ctx.actions.addTab(selectedProjectId, selectedTaskId, 'left', claudeTabType(aiType, config?.claudeDefaultView ?? 'terminal'))
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

// Ctrl+L / Ctrl+Shift+L are bound inside editor and notebook tabs (Monaco actions
// and the notebook's own key handler); these entries make them findable and list
// the shortcut. The tab that had focus when the palette opened answers.
function selectedTaskHasFileTab(actions: Pick<AppCtx['actions'], 'projects' | 'selectedProjectId' | 'selectedTaskId'>): boolean {
  const project = actions.projects?.find(p => p.id === actions.selectedProjectId)
  const task = findTaskInProject(project, actions.selectedTaskId)
  if (!task) return false
  return taskTabs(task).some(t => t.type === 'editor' || t.type === 'notebook')
}

function emitLinkToAgent(kind: 'selection' | 'file'): void {
  const request = { kind, target: getPaletteReturnFocus(), handled: false }
  paletteEvents.emit('link-to-agent', request)
  if (!request.handled) {
    paletteEvents.emit('agent-link-notice', 'Put the cursor in an editor or notebook first, then link.')
  }
}

commandRegistry.register({
  id: 'cmd.linkSelectionToAgent',
  title: 'Link Selection to Agent',
  aliases: ['add to chat', 'link line', 'link cell', 'mention'],
  shortcut: 'CmdOrCtrl+L',
  when: ctx => selectedTaskHasFileTab(ctx.actions),
  run: () => emitLinkToAgent('selection')
})

commandRegistry.register({
  id: 'cmd.linkFileToAgent',
  title: 'Link File to Agent',
  aliases: ['add file to chat', 'link notebook', 'mention file'],
  shortcut: 'CmdOrCtrl+Shift+L',
  when: ctx => selectedTaskHasFileTab(ctx.actions),
  run: () => emitLinkToAgent('file')
})

commandRegistry.register({
  id: 'cmd.toggleSidebar',
  title: 'Toggle Sidebar',
  aliases: ['sidebar'],
  shortcut: 'CmdOrCtrl+B',
  run: () => paletteEvents.emit('toggle-sidebar')
})

commandRegistry.register({
  id: 'cmd.toggleFileBrowser',
  title: 'Toggle File Browser',
  aliases: ['files', 'browser panel'],
  shortcut: 'CmdOrCtrl+Shift+E',
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
  shortcut: 'CmdOrCtrl+Alt+I',
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


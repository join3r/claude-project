/**
 * The whole app's state and actions, composed from per-domain hooks under
 * `./appState/`. This file only wires them together; the logic lives in the
 * domain hooks, and the pure `prev -> next` transitions they apply live in
 * `appState/{projectsData,viewState,notesData,inbox,zoom}.ts`.
 *
 * Hook call order matters: it fixes the order the effects run in, and each
 * domain hook reads refs written by `useAppStateCore` during the same render.
 */
import type { AppConfig, PinnedItem, Project, Tag, Task } from '../../shared/types'
import { useAppStateCore, usePersistence } from './appState/useAppStateCore'
import { useDirtyClosePrompt, type DirtyCloseActions } from './appState/useDirtyClosePrompt'
import {
  useNativeTheme,
  useSelectionSync,
  useTasksRemovedListener,
  useTabsRemovedListener,
  useWindowFocused,
  useWindowTitle
} from './appState/useWindowEffects'
import { useConnectSsh } from './appState/remote'
import { useTaskInbox, type TaskInboxActions } from './appState/useTaskInbox'
import { useSelection, type SelectionActions } from './appState/useSelection'
import { useProjects, type ProjectsActions } from './appState/useProjects'
import { useTasks, type TasksActions } from './appState/useTasks'
import { useTabs, type TabsActions } from './appState/useTabs'
import { useNotes, type NotesActions } from './appState/useNotes'
import { useWindowLayout, type WindowLayoutActions } from './appState/useWindowLayout'
import { useZoom, type ZoomActions } from './appState/useZoom'
import { findTaskInProject } from '../../shared/streams'

export { buildWindowTitle } from './appState/windowTitle'
export type { DirtyClosePrompt, DirtyCloseChoice } from './appState/useDirtyClosePrompt'
export type { ProjectUpdate } from './appState/useProjects'

/** Shared data and derived selection, as rendered. */
export interface AppDataState {
  projects: Project[]
  tags: Tag[]
  projectOrder: string[]
  pinnedItems: PinnedItem[]
  config: AppConfig | null
  updateConfig: (updates: Partial<AppConfig>) => void
  selectedProject: Project | null
  selectedTask: Task | null
  selectedProjectId: string | null
  selectedTaskId: string | null
  effectiveTheme: 'dark' | 'light'
  effectiveTerminalTheme: 'dark' | 'light'
  /** Set when this window permanently failed to persist; what is on screen is main's state. */
  stateSyncError: string | null
  dismissStateSyncError: () => void
}

export type AppActions =
  & AppDataState
  & SelectionActions
  & TaskInboxActions
  & ProjectsActions
  & TasksActions
  & TabsActions
  & DirtyCloseActions
  & NotesActions
  & WindowLayoutActions
  & ZoomActions

export function useAppState(): AppActions {
  const core = useAppStateCore()
  const theme = useNativeTheme()
  const dirty = useDirtyClosePrompt()
  useTasksRemovedListener(core.updateWindowViewState)
  useTabsRemovedListener()
  const windowFocused = useWindowFocused()
  usePersistence(core)
  const connectSsh = useConnectSsh()
  useSelectionSync(core, windowFocused, connectSsh)

  const inbox = useTaskInbox(core)
  const selection = useSelection(core, connectSsh, inbox.markTaskVisited)
  const projectActions = useProjects(core, {
    connectSsh,
    confirmDiscardDirty: dirty.confirmDiscardDirty,
    selectProject: selection.setSelectedProjectId
  })
  const tasks = useTasks(core, { confirmDiscardDirty: dirty.confirmDiscardDirty })
  const tabs = useTabs(core, { connectSsh, confirmDiscardDirty: dirty.confirmDiscardDirty })
  const notes = useNotes(core, {
    addTab: tabs.addTab,
    setActiveTab: tabs.setActiveTab,
    switchToTask: selection.switchToTask
  })
  const layout = useWindowLayout(core)
  const { config, projectsData, windowViewState } = core
  const zoom = useZoom(config?.fontSize, config?.editorFontSize, core.updateConfig)

  const { projects } = projectsData
  const selectedProjectId = windowViewState.selectedProjectId
  const selectedTaskId = windowViewState.selectedTaskId
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null
  const selectedTask = findTaskInProject(selectedProject, selectedTaskId) ?? null

  const effectiveTheme = config?.theme === 'system' || !config ? theme : config.theme
  const effectiveTerminalTheme = config?.terminalTheme === 'system' || !config ? theme : config.terminalTheme

  useWindowTitle(selectedProject, selectedTask)

  return {
    projects,
    tags: projectsData.tags,
    projectOrder: projectsData.projectOrder,
    pinnedItems: projectsData.pinnedItems,
    config,
    updateConfig: core.updateConfig,
    selectedProject,
    selectedTask,
    selectedProjectId,
    selectedTaskId,
    effectiveTheme,
    effectiveTerminalTheme,
    stateSyncError: core.stateSyncError,
    dismissStateSyncError: core.dismissStateSyncError,
    ...selection,
    ...inbox,
    ...projectActions,
    ...tasks,
    ...tabs,
    ...dirty,
    ...notes,
    ...layout,
    ...zoom
  }
}

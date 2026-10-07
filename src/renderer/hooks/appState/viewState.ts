/**
 * Pure transitions of this window's `WindowViewState`: selection, expansion,
 * per-task pane state and the file-browser sidebar. None of this is shared with
 * other windows, so these are plain `prev -> next` steps with no sync concerns.
 */
import { createTaskViewState, reconcileTaskViewState } from '../../../shared/types'
import type { FileBrowserTab, Project, Task, TaskViewState, WindowViewState } from '../../../shared/types'
import type { Pane } from './projectsData'
import { paneTabs, projectLastTaskId, projectTasks } from '../../../shared/streams'

export function areWindowStatesEqual(a: WindowViewState, b: WindowViewState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function cloneTaskState(state: TaskViewState): TaskViewState {
  return {
    activeTab: {
      left: state.activeTab.left,
      right: state.activeTab.right
    },
    splitOpen: state.splitOpen,
    splitRatio: state.splitRatio,
    ...(state.fileBrowserOpen !== undefined ? { fileBrowserOpen: state.fileBrowserOpen } : {}),
    ...(state.fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab: state.fileBrowserActiveTab } : {})
  }
}

/** `ids` with `id` present exactly once, keeping identity when it already was. */
export function withId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id]
}

/** Add `id` when absent, remove it when present. */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(candidate => candidate !== id) : [...ids, id]
}

export function setProjectExpandedView(prev: WindowViewState, projectId: string, expanded: boolean): WindowViewState {
  const isExpanded = prev.expandedProjectIds.includes(projectId)
  if (isExpanded === expanded) return prev
  return {
    ...prev,
    expandedProjectIds: expanded
      ? [...prev.expandedProjectIds, projectId]
      : prev.expandedProjectIds.filter(id => id !== projectId)
  }
}

export function clampFileBrowserWidth(width: number): number {
  return Math.min(400, Math.max(150, width))
}

export function clampSidebarWidth(width: number): number {
  return Math.min(420, Math.max(180, width))
}

/** Store `state` (cloned) as the view state of `taskId`. */
export function withTaskState(prev: WindowViewState, taskId: string, state: TaskViewState): WindowViewState {
  return {
    ...prev,
    taskStates: {
      ...prev.taskStates,
      [taskId]: cloneTaskState(state)
    }
  }
}

/** `current` with `tabId` active in `pane`, as a detached copy. */
export function withActiveTab(current: TaskViewState, pane: Pane, tabId: string | null): TaskViewState {
  return {
    ...cloneTaskState(current),
    activeTab: {
      ...current.activeTab,
      [pane]: tabId
    }
  }
}

/**
 * Select a project, restoring the task it was last left on when that task still
 * exists, and expand it in the sidebar. `null` clears the selection.
 */
export function selectProjectView(prev: WindowViewState, id: string | null, project: Project | null): WindowViewState {
  if (!id) {
    return { ...prev, selectedProjectId: null, selectedTaskId: null }
  }
  const restoredTaskId = (project && projectLastTaskId(project)) ?? null
  return {
    ...prev,
    selectedProjectId: id,
    selectedTaskId: restoredTaskId,
    expandedProjectIds: withId(prev.expandedProjectIds, id)
  }
}

/** Land on the project's home task with its home tab in front. */
export function selectProjectHomeView(prev: WindowViewState, projectId: string, homeTask: Task): WindowViewState {
  const homeTab = paneTabs(homeTask, 'left').find(t => t.system === 'home') ?? null
  const prevTaskState = prev.taskStates[homeTask.id] ?? createTaskViewState(homeTask)
  return {
    ...prev,
    selectedProjectId: projectId,
    selectedTaskId: homeTask.id,
    expandedProjectIds: withId(prev.expandedProjectIds, projectId),
    taskStates: {
      ...prev.taskStates,
      [homeTask.id]: {
        ...prevTaskState,
        activeTab: {
          ...prevTaskState.activeTab,
          left: homeTab?.id ?? prevTaskState.activeTab.left
        }
      }
    }
  }
}

export function switchToTaskView(prev: WindowViewState, projectId: string, taskId: string): WindowViewState {
  return {
    ...prev,
    selectedProjectId: projectId,
    selectedTaskId: taskId,
    expandedProjectIds: withId(prev.expandedProjectIds, projectId)
  }
}

/** Select a freshly created task and give it its initial pane state. */
export function selectNewTaskView(prev: WindowViewState, projectId: string, task: Task): WindowViewState {
  return {
    ...prev,
    selectedProjectId: projectId,
    selectedTaskId: task.id,
    taskStates: {
      ...prev.taskStates,
      [task.id]: createTaskViewState(task)
    }
  }
}

/**
 * Forget a removed task's view state and deselect it. `ownerRetired` also clears
 * the project selection, for a hidden project that went with its last task.
 */
export function removeTaskView(
  prev: WindowViewState,
  projectId: string,
  taskId: string,
  ownerRetired: boolean
): WindowViewState {
  const taskStates = { ...prev.taskStates }
  delete taskStates[taskId]
  return {
    ...prev,
    selectedProjectId: ownerRetired && prev.selectedProjectId === projectId ? null : prev.selectedProjectId,
    selectedTaskId: prev.selectedTaskId === taskId ? null : prev.selectedTaskId,
    taskStates
  }
}

/** Main deleted a task by itself (idle cleanup); drop what this window kept for it. */
export function forgetRemovedTaskView(prev: WindowViewState, taskId: string): WindowViewState {
  if (!(taskId in prev.taskStates) && prev.selectedTaskId !== taskId) return prev
  const taskStates = { ...prev.taskStates }
  delete taskStates[taskId]
  return {
    ...prev,
    selectedTaskId: prev.selectedTaskId === taskId ? null : prev.selectedTaskId,
    taskStates
  }
}

export function removeProjectView(prev: WindowViewState, projectId: string): WindowViewState {
  return {
    ...prev,
    selectedProjectId: prev.selectedProjectId === projectId ? null : prev.selectedProjectId,
    selectedTaskId: prev.selectedProjectId === projectId ? null : prev.selectedTaskId,
    expandedProjectIds: prev.expandedProjectIds.filter(pid => pid !== projectId)
  }
}

export interface SidebarPatch {
  fileBrowserOpen?: boolean
  fileBrowserActiveTab?: FileBrowserTab
}

/**
 * Apply a file-browser change to the window and remember it on the current task
 * (`task` is the selected one, resolved by the caller), so switching tasks
 * restores each task's own sidebar.
 */
export function writeSidebarToTask(prev: WindowViewState, task: Task | null, patch: SidebarPatch): WindowViewState {
  const taskId = prev.selectedTaskId
  const next: WindowViewState = {
    ...prev,
    ...(patch.fileBrowserOpen !== undefined ? { fileBrowserOpen: patch.fileBrowserOpen } : {}),
    ...(patch.fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab: patch.fileBrowserActiveTab } : {})
  }
  if (!taskId || !task) return next
  const currentState = reconcileTaskViewState(task, prev.taskStates[taskId])
  next.taskStates = {
    ...prev.taskStates,
    [taskId]: {
      ...cloneTaskState(currentState),
      ...(patch.fileBrowserOpen !== undefined ? { fileBrowserOpen: patch.fileBrowserOpen } : {}),
      ...(patch.fileBrowserActiveTab !== undefined ? { fileBrowserActiveTab: patch.fileBrowserActiveTab } : {})
    }
  }
  return next
}

/**
 * The file-browser state to show on landing on `task`: what was saved for it,
 * else open-on-notes for a home task, else whatever the window already shows.
 */
export function sidebarForTask(
  view: Pick<WindowViewState, 'taskStates' | 'fileBrowserOpen' | 'fileBrowserActiveTab'>,
  task: Task
): { fileBrowserOpen: boolean; fileBrowserActiveTab: FileBrowserTab } {
  const saved = view.taskStates[task.id]
  const isHome = task.system === 'home'
  const fileBrowserOpen = saved?.fileBrowserOpen !== undefined
    ? saved.fileBrowserOpen
    : isHome
      ? true
      : view.fileBrowserOpen
  const fileBrowserActiveTab: FileBrowserTab = saved?.fileBrowserActiveTab !== undefined
    ? saved.fileBrowserActiveTab
    : isHome
      ? 'notes'
      : view.fileBrowserActiveTab
  return { fileBrowserOpen, fileBrowserActiveTab }
}

/**
 * After a note is deleted, move every pane that was showing one of its tabs onto
 * the last remaining tab in that pane.
 */
export function reassignActiveTabsAfterNoteDelete(
  prev: WindowViewState,
  project: Project,
  noteId: string
): WindowViewState {
  const isDoomed = (tab: { type: string; noteId?: string }) => tab.type === 'note' && tab.noteId === noteId
  const nextTaskStates = { ...prev.taskStates }
  for (const task of projectTasks(project)) {
    const currentState = reconcileTaskViewState(task, prev.taskStates[task.id])
    const nextActiveTab = { ...currentState.activeTab }
    let changed = false
    for (const pane of ['left', 'right'] as const) {
      const activeId = currentState.activeTab[pane]
      const activeTab = paneTabs(task, pane).find(tab => tab.id === activeId)
      if (activeTab && isDoomed(activeTab)) {
        const remaining = paneTabs(task, pane).filter(tab => !isDoomed(tab))
        nextActiveTab[pane] = remaining[remaining.length - 1]?.id ?? null
        changed = true
      }
    }
    if (changed) {
      nextTaskStates[task.id] = {
        ...cloneTaskState(currentState),
        activeTab: nextActiveTab
      }
    }
  }
  return { ...prev, taskStates: nextTaskStates }
}

import { useCallback, useRef } from 'react'
import { isNotebookFile } from '../../../shared/notebook'
import { v4 as uuid } from 'uuid'
import {
  AI_TAB_META,
  CLAUDE_CHAT_LABEL,
  createTaskViewState,
  isHomeTab,
  reconcileTaskViewState
} from '../../../shared/types'
import type { Tab, TabType, Task, TaskViewState } from '../../../shared/types'
import { findTaskInProject, paneTabs, tabsByPane, taskTabs, withTabsByPane } from '../../../shared/streams'
import { markClaudeHandoff } from '../../components/claudeTabHandoff'
import { createTab, type CreateTabOptions } from '../../components/newTaskTabs'
import { moveTaskTab } from '../../tabMove'
import {
  pushRecentlyClosedTab,
  shiftRestorableClosedTab,
  type RecentlyClosedTab
} from '../../recentlyClosedTabs'
import type { AppStateCore } from './useAppStateCore'
import { ensureRemoteConnected, type ConnectSsh } from './remote'
import {
  findTask,
  insertTabAt,
  mapPaneTabs,
  mapTask,
  paneOfTab,
  patchTab,
  renameTabInData,
  type Pane
} from './projectsData'
import { cloneTaskState, withActiveTab, withTaskState } from './viewState'

export interface TabsActions {
  addTab: (projectId: string, taskId: string, pane: Pane, type: TabType, arg?: string | CreateTabOptions) => Tab
  removeTab: (projectId: string, taskId: string, pane: Pane, tabId: string) => Promise<void>
  renameTab: (projectId: string, taskId: string, pane: Pane, tabId: string, title: string) => void
  /** Restore the most recently closed tab that still has a home; returns the pane it went to. */
  reopenClosedTab: () => Pane | null
  updateTabUrl: (projectId: string, taskId: string, pane: Pane, tabId: string, url: string) => void
  updateTabSessionId: (projectId: string, taskId: string, pane: Pane, tabId: string, sessionId: string) => void
  convertClaudeTab: (projectId: string, taskId: string, pane: Pane, tabId: string, to: 'claude' | 'claude-chat') => void
  setActiveTab: (projectId: string, taskId: string, pane: Pane, tabId: string) => void
  moveTab: (projectId: string, taskId: string, fromPane: Pane, tabId: string, toPane: Pane, toIndex: number) => void
  getTaskViewState: (task: Task) => TaskViewState
  toggleSplit: (projectId: string, taskId: string) => void
  setSplitRatio: (projectId: string, taskId: string, ratio: number) => void
  openOrFocusDiffTab: (projectId: string, taskId: string, pane: Pane, filePath: string) => void
  openOrFocusEditorTab: (projectId: string, taskId: string, pane: Pane, filePath: string) => void
}

/** The placeholder a tab add falls back to when its task is not in `projectsRef` yet. */
function blankTask(taskId: string): Task {
  return { id: taskId, name: '', panes: [] }
}

/** Tabs within a task, the split between its two panes, and recently-closed history. */
export function useTabs(
  core: AppStateCore,
  deps: {
    connectSsh: ConnectSsh
    confirmDiscardDirty: (tabIds: string[]) => Promise<'proceed' | 'cancel'>
  }
): TabsActions {
  const { mutateProjects, projectsRef, updateWindowViewState, getTaskViewStateForTask } = core
  const { connectSsh, confirmDiscardDirty } = deps
  const recentlyClosedTabsRef = useRef<RecentlyClosedTab[]>([])

  const cleanupClosedTabHistory = useCallback((entries: RecentlyClosedTab[]) => {
    for (const entry of entries) {
      void window.api.scrollbackDelete(entry.tab.id)
    }
  }, [])

  const rememberClosedTab = useCallback((entry: RecentlyClosedTab) => {
    const next = pushRecentlyClosedTab(recentlyClosedTabsRef.current, entry)
    recentlyClosedTabsRef.current = next.history
    cleanupClosedTabHistory(next.evicted)
  }, [cleanupClosedTabHistory])

  const renameTab = useCallback((
    projectId: string,
    taskId: string,
    pane: Pane,
    tabId: string,
    title: string
  ) => {
    const trimmed = title.trim()
    if (!trimmed) return
    mutateProjects(prev => renameTabInData(prev, projectId, taskId, pane, tabId, trimmed))
  }, [mutateProjects])

  const addTab = useCallback((
    projectId: string,
    taskId: string,
    pane: Pane,
    type: TabType,
    arg?: string | CreateTabOptions
  ) => {
    const options = typeof arg === 'string' ? { filePath: arg } : (arg ?? {})
    const tab = createTab(type, options)

    mutateProjects(prev => mapPaneTabs(prev, projectId, taskId, pane, tabs => [...tabs, tab]))

    updateWindowViewState(prev => {
      const task = findTask(projectsRef.current, projectId, taskId)
      const currentState = task ? getTaskViewStateForTask(task) : createTaskViewState(blankTask(taskId))
      return {
        ...prev,
        taskStates: {
          ...prev.taskStates,
          [taskId]: withActiveTab(currentState, pane, tab.id)
        }
      }
    })

    return tab
  }, [mutateProjects, updateWindowViewState, getTaskViewStateForTask])

  const removeTab = useCallback(async (projectId: string, taskId: string, pane: Pane, tabId: string) => {
    if (await confirmDiscardDirty([tabId]) === 'cancel') return

    const task = findTask(projectsRef.current, projectId, taskId)
    const tabIndex = task ? paneTabs(task, pane).findIndex(tab => tab.id === tabId) : -1
    const removedTab = task && tabIndex >= 0 ? paneTabs(task, pane)[tabIndex] ?? null : null
    if (removedTab && isHomeTab(removedTab)) return

    if (removedTab && tabIndex >= 0) {
      rememberClosedTab({
        projectId,
        taskId,
        pane,
        index: tabIndex,
        tab: removedTab
      })
    }

    updateWindowViewState(prev => {
      if (!task) return prev

      const currentState = getTaskViewStateForTask(task)
      const nextTabs = paneTabs(task, pane).filter(tab => tab.id !== tabId)
      const wasActive = currentState.activeTab[pane] === tabId

      return {
        ...prev,
        taskStates: {
          ...prev.taskStates,
          [taskId]: withActiveTab(
            currentState,
            pane,
            wasActive ? (nextTabs[nextTabs.length - 1]?.id ?? null) : currentState.activeTab[pane]
          )
        }
      }
    })

    mutateProjects(prev => mapPaneTabs(prev, projectId, taskId, pane, tabs => tabs.filter(tab => tab.id !== tabId)))

    window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
  }, [confirmDiscardDirty, mutateProjects, updateWindowViewState, getTaskViewStateForTask, rememberClosedTab])

  const reopenClosedTab = useCallback((): Pane | null => {
    const next = shiftRestorableClosedTab(recentlyClosedTabsRef.current, projectsRef.current)
    recentlyClosedTabsRef.current = next.history
    cleanupClosedTabHistory(next.stale)

    if (!next.entry) return null

    const { projectId, taskId, pane, index, tab } = next.entry
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = findTaskInProject(project, taskId)
    if (!project || !task) {
      cleanupClosedTabHistory([next.entry])
      return null
    }

    mutateProjects(prev => insertTabAt(prev, projectId, taskId, pane, index, tab))

    updateWindowViewState(prev => {
      const currentState = getTaskViewStateForTask(task)
      return {
        ...prev,
        selectedProjectId: projectId,
        selectedTaskId: taskId,
        taskStates: {
          ...prev.taskStates,
          [taskId]: withActiveTab(currentState, pane, tab.id)
        }
      }
    })

    ensureRemoteConnected(projectId, project, connectSsh)

    return pane
  }, [cleanupClosedTabHistory, connectSsh, mutateProjects, updateWindowViewState, getTaskViewStateForTask])

  const updateTabUrl = useCallback((projectId: string, taskId: string, pane: Pane, tabId: string, url: string) => {
    mutateProjects(prev => patchTab(prev, projectId, taskId, pane, tabId, { url }))
  }, [mutateProjects])

  const updateTabSessionId = useCallback((projectId: string, taskId: string, pane: Pane, tabId: string, sessionId: string) => {
    mutateProjects(prev => patchTab(prev, projectId, taskId, pane, tabId, { sessionId }))
  }, [mutateProjects])

  /**
   * Turn a Claude tab into the other kind — terminal ⇄ chat — on the same session.
   * The old kind's process is ended first (through the same `tab-removed` teardown
   * a close runs, which is what the mounted component listens for), so the new one
   * resumes a session nothing else is writing to.
   */
  const convertClaudeTab = useCallback((projectId: string, taskId: string, pane: Pane, tabId: string, to: 'claude' | 'claude-chat') => {
    const owner = findTask(projectsRef.current, projectId, taskId)
    const tab = owner ? paneTabs(owner, pane).find(candidate => candidate.id === tabId) : undefined
    if (!tab || tab.type === to || (tab.type !== 'claude' && tab.type !== 'claude-chat')) return
    window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
    void window.api.scrollbackDelete(tabId)
    markClaudeHandoff(tabId)
    const defaultTitles = [AI_TAB_META.claude.label, CLAUDE_CHAT_LABEL]
    const title = defaultTitles.includes(tab.title) ? (to === 'claude' ? AI_TAB_META.claude.label : CLAUDE_CHAT_LABEL) : tab.title
    const sessionId = tab.sessionId ?? uuid()
    mutateProjects(prev => patchTab(prev, projectId, taskId, pane, tabId, { type: to, title, sessionId }))
  }, [mutateProjects])

  const setActiveTab = useCallback((projectId: string, taskId: string, pane: Pane, tabId: string) => {
    const task = findTask(projectsRef.current, projectId, taskId)
    if (!task) return

    updateWindowViewState(prev => {
      const currentState = reconcileTaskViewState(task, prev.taskStates[taskId])
      return {
        ...prev,
        taskStates: {
          ...prev.taskStates,
          [taskId]: withActiveTab(currentState, pane, tabId)
        }
      }
    })
  }, [updateWindowViewState])

  const moveTab = useCallback((projectId: string, taskId: string, fromPane: Pane, tabId: string, toPane: Pane, toIndex: number) => {
    const task = findTask(projectsRef.current, projectId, taskId)
    if (!task) return

    const currentState = getTaskViewStateForTask(task)
    const next = moveTaskTab({
      tabs: tabsByPane(task),
      taskState: currentState,
      fromPane,
      tabId,
      toPane,
      toIndex
    })

    if (!next.moved) return

    updateWindowViewState(prev => withTaskState(prev, taskId, next.taskState))
    mutateProjects(prev => mapTask(prev, projectId, taskId, candidate => withTabsByPane(candidate, next.tabs)))
  }, [mutateProjects, updateWindowViewState, getTaskViewStateForTask])

  const toggleSplit = useCallback((projectId: string, taskId: string) => {
    const task = findTask(projectsRef.current, projectId, taskId)
    if (!task) return

    updateWindowViewState(prev => {
      const currentState = reconcileTaskViewState(task, prev.taskStates[taskId])
      return {
        ...prev,
        taskStates: {
          ...prev.taskStates,
          [taskId]: {
            ...cloneTaskState(currentState),
            splitOpen: !currentState.splitOpen
          }
        }
      }
    })
  }, [updateWindowViewState])

  const setSplitRatio = useCallback((projectId: string, taskId: string, ratio: number) => {
    const task = findTask(projectsRef.current, projectId, taskId)
    if (!task) return

    updateWindowViewState(prev => {
      const currentState = reconcileTaskViewState(task, prev.taskStates[taskId])
      return {
        ...prev,
        taskStates: {
          ...prev.taskStates,
          [taskId]: {
            ...cloneTaskState(currentState),
            splitRatio: ratio
          }
        }
      }
    })
  }, [updateWindowViewState])

  /** Focus the task's existing tab of `type` for `filePath`, or open one in `pane`. */
  const openOrFocusFileTab = useCallback((
    type: 'diff' | 'editor',
    projectId: string,
    taskId: string,
    pane: Pane,
    filePath: string
  ) => {
    const task = findTask(projectsRef.current, projectId, taskId)
    if (!task) return

    // An .ipynb opens as (and matches) a native notebook tab, not a text editor.
    const existingTab = taskTabs(task).find(
      t => t.filePath === filePath && (t.type === type || (type === 'editor' && t.type === 'notebook'))
    )
    if (existingTab) {
      setActiveTab(projectId, taskId, paneOfTab(task, existingTab), existingTab.id)
      return
    }

    addTab(projectId, taskId, pane, type === 'editor' && isNotebookFile(filePath) ? 'notebook' : type, filePath)
  }, [addTab, setActiveTab])

  const openOrFocusDiffTab = useCallback((projectId: string, taskId: string, pane: Pane, filePath: string) => {
    openOrFocusFileTab('diff', projectId, taskId, pane, filePath)
  }, [openOrFocusFileTab])

  const openOrFocusEditorTab = useCallback((projectId: string, taskId: string, pane: Pane, filePath: string) => {
    openOrFocusFileTab('editor', projectId, taskId, pane, filePath)
  }, [openOrFocusFileTab])

  return {
    addTab,
    removeTab,
    renameTab,
    reopenClosedTab,
    updateTabUrl,
    updateTabSessionId,
    convertClaudeTab,
    setActiveTab,
    moveTab,
    getTaskViewState: getTaskViewStateForTask,
    toggleSplit,
    setSplitRatio,
    openOrFocusDiffTab,
    openOrFocusEditorTab
  }
}

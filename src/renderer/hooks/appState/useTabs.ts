import { useCallback, useRef } from 'react'
import { isNotebookFile } from '../../../shared/notebook'
import { v4 as uuid } from 'uuid'
import { AI_TAB_META, CLAUDE_CHAT_LABEL } from '../../../shared/types'
import type { Tab, TabType } from '../../../shared/types'
import { canAddTabType, findTaskInProject, isMainTab, taskTabs } from '../../../shared/streams'
import {
  addTabToPane,
  findTabLocation,
  moveTabInTask,
  removeTabFromTask,
  setActiveTabInTask,
  setPaneWidths as setPaneWidthsInTask,
  type PaneDropTarget
} from '../../../shared/panes'
import { markClaudeHandoff } from '../../components/claudeTabHandoff'
import { createTab, type CreateTabOptions } from '../../components/newTaskTabs'
import { resolvePaneRef, setFocusedPane, type PaneRef } from '../../components/paneFocus'
import {
  pushRecentlyClosedTab,
  shiftRestorableClosedTab,
  type RecentlyClosedTab
} from '../../recentlyClosedTabs'
import type { AppStateCore } from './useAppStateCore'
import { ensureRemoteConnected, type ConnectSsh } from './remote'
import { findTask, insertTabAt, mapTask, patchTab, renameTabInData } from './projectsData'

export interface TabsActions {
  /** The new tab, or null when the task already has an agent and `type` is one (a second agent is a new task). */
  addTab: (projectId: string, taskId: string, pane: PaneRef, type: TabType, arg?: string | CreateTabOptions) => Tab | null
  removeTab: (projectId: string, taskId: string, tabId: string) => Promise<void>
  renameTab: (projectId: string, taskId: string, tabId: string, title: string) => void
  /** Restore the most recently closed tab that still has a home; returns the pane it went to. */
  reopenClosedTab: () => number | null
  updateTabUrl: (projectId: string, taskId: string, tabId: string, url: string) => void
  updateTabSessionId: (projectId: string, taskId: string, tabId: string, sessionId: string) => void
  convertClaudeTab: (projectId: string, taskId: string, tabId: string, to: 'claude' | 'claude-chat') => void
  setActiveTab: (projectId: string, taskId: string, tabId: string) => void
  moveTab: (projectId: string, taskId: string, tabId: string, target: PaneDropTarget) => void
  /** Move the tab into a new pane to the right of its own. */
  splitTabRight: (projectId: string, taskId: string, tabId: string) => void
  setPaneWidths: (projectId: string, taskId: string, widths: number[]) => void
  openOrFocusDiffTab: (projectId: string, taskId: string, pane: PaneRef, filePath: string) => void
  openOrFocusEditorTab: (projectId: string, taskId: string, pane: PaneRef, filePath: string) => void
}

/** Tabs within a task, its pane row, and recently-closed history. */
export function useTabs(
  core: AppStateCore,
  deps: {
    connectSsh: ConnectSsh
    confirmDiscardDirty: (tabIds: string[]) => Promise<'proceed' | 'cancel'>
  }
): TabsActions {
  const { mutateProjects, projectsRef, updateWindowViewState } = core
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

  const renameTab = useCallback((projectId: string, taskId: string, tabId: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    mutateProjects(prev => renameTabInData(prev, projectId, taskId, tabId, trimmed))
  }, [mutateProjects])

  const addTab = useCallback((
    projectId: string,
    taskId: string,
    pane: PaneRef,
    type: TabType,
    arg?: string | CreateTabOptions
  ) => {
    const task = findTask(projectsRef.current, projectId, taskId)
    if (task && !canAddTabType(task, type)) return null
    const options = typeof arg === 'string' ? { filePath: arg } : (arg ?? {})
    const tab = createTab(type, options)
    // Resolved once, up front, so a replayed updater lands the tab in the same column.
    const paneIndex = task ? resolvePaneRef(task, pane) : 0

    mutateProjects(prev => mapTask(prev, projectId, taskId, candidate => addTabToPane(candidate, paneIndex, tab)))
    setFocusedPane(taskId, paneIndex)

    return tab
  }, [mutateProjects])

  const removeTab = useCallback(async (projectId: string, taskId: string, tabId: string) => {
    // The main tab closes only with its task, so recently-closed only ever holds plain tabs.
    const owner = findTask(projectsRef.current, projectId, taskId)
    if (owner && isMainTab(owner, tabId)) return
    if (await confirmDiscardDirty([tabId]) === 'cancel') return

    const task = findTask(projectsRef.current, projectId, taskId)
    const at = task ? findTabLocation(task, tabId) : null
    if (task && at) {
      rememberClosedTab({
        projectId,
        taskId,
        pane: at.pane,
        index: at.index,
        tab: task.panes[at.pane].tabs[at.index]
      })
    }

    mutateProjects(prev => mapTask(prev, projectId, taskId, candidate => removeTabFromTask(candidate, tabId)))

    window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
  }, [confirmDiscardDirty, mutateProjects, rememberClosedTab])

  const reopenClosedTab = useCallback((): number | null => {
    const next = shiftRestorableClosedTab(recentlyClosedTabsRef.current, projectsRef.current)
    recentlyClosedTabsRef.current = next.history
    cleanupClosedTabHistory(next.stale)

    if (!next.entry) return null

    const { projectId, taskId, index, tab } = next.entry
    const project = projectsRef.current.find(candidate => candidate.id === projectId)
    const task = findTaskInProject(project, taskId)
    // A stray second agent tab (from before one agent per task) doesn't come back.
    if (!project || !task || !canAddTabType(task, tab.type)) {
      cleanupClosedTabHistory([next.entry])
      return null
    }

    // Its column may have closed with it: then it opens in the nearest one left.
    const pane = Math.max(0, Math.min(next.entry.pane, task.panes.length - 1))
    mutateProjects(prev => insertTabAt(prev, projectId, taskId, pane, index, tab))
    setFocusedPane(taskId, pane)

    updateWindowViewState(prev => ({ ...prev, selectedProjectId: projectId, selectedTaskId: taskId }))

    ensureRemoteConnected(projectId, project, connectSsh)

    return pane
  }, [cleanupClosedTabHistory, connectSsh, mutateProjects, updateWindowViewState])

  const updateTabUrl = useCallback((projectId: string, taskId: string, tabId: string, url: string) => {
    mutateProjects(prev => patchTab(prev, projectId, taskId, tabId, { url }))
  }, [mutateProjects])

  const updateTabSessionId = useCallback((projectId: string, taskId: string, tabId: string, sessionId: string) => {
    mutateProjects(prev => patchTab(prev, projectId, taskId, tabId, { sessionId }))
  }, [mutateProjects])

  /**
   * Turn a Claude tab into the other kind — terminal ⇄ chat — on the same session.
   * The old kind's process is ended first (through the same `tab-removed` teardown
   * a close runs, which is what the mounted component listens for), so the new one
   * resumes a session nothing else is writing to.
   */
  const convertClaudeTab = useCallback((projectId: string, taskId: string, tabId: string, to: 'claude' | 'claude-chat') => {
    const owner = findTask(projectsRef.current, projectId, taskId)
    const tab = owner ? taskTabs(owner).find(candidate => candidate.id === tabId) : undefined
    if (!tab || tab.type === to || (tab.type !== 'claude' && tab.type !== 'claude-chat')) return
    window.dispatchEvent(new CustomEvent('tab-removed', { detail: { tabId } }))
    void window.api.scrollbackDelete(tabId)
    markClaudeHandoff(tabId)
    const defaultTitles = [AI_TAB_META.claude.label, CLAUDE_CHAT_LABEL]
    const title = defaultTitles.includes(tab.title) ? (to === 'claude' ? AI_TAB_META.claude.label : CLAUDE_CHAT_LABEL) : tab.title
    const sessionId = tab.sessionId ?? uuid()
    mutateProjects(prev => patchTab(prev, projectId, taskId, tabId, { type: to, title, sessionId }))
  }, [mutateProjects])

  const setActiveTab = useCallback((projectId: string, taskId: string, tabId: string) => {
    const task = findTask(projectsRef.current, projectId, taskId)
    const at = task ? findTabLocation(task, tabId) : null
    if (!at) return
    setFocusedPane(taskId, at.pane)
    mutateProjects(prev => mapTask(prev, projectId, taskId, candidate => setActiveTabInTask(candidate, tabId)))
  }, [mutateProjects])

  const moveTab = useCallback((projectId: string, taskId: string, tabId: string, target: PaneDropTarget) => {
    const task = findTask(projectsRef.current, projectId, taskId)
    if (!task) return
    const moved = moveTabInTask(task, tabId, target)
    if (moved === task) return
    const landed = findTabLocation(moved, tabId)
    if (landed) setFocusedPane(taskId, landed.pane)
    mutateProjects(prev => mapTask(prev, projectId, taskId, candidate => moveTabInTask(candidate, tabId, target)))
  }, [mutateProjects])

  const splitTabRight = useCallback((projectId: string, taskId: string, tabId: string) => {
    const task = findTask(projectsRef.current, projectId, taskId)
    const at = task ? findTabLocation(task, tabId) : null
    if (!at) return
    moveTab(projectId, taskId, tabId, { kind: 'split', pane: at.pane, side: 'right' })
  }, [moveTab])

  const setPaneWidths = useCallback((projectId: string, taskId: string, widths: number[]) => {
    mutateProjects(prev => mapTask(prev, projectId, taskId, task => setPaneWidthsInTask(task, widths)))
  }, [mutateProjects])

  /** Focus the task's existing tab of `type` for `filePath`, or open one in `pane`. */
  const openOrFocusFileTab = useCallback((
    type: 'diff' | 'editor',
    projectId: string,
    taskId: string,
    pane: PaneRef,
    filePath: string
  ) => {
    const task = findTask(projectsRef.current, projectId, taskId)
    if (!task) return

    // An .ipynb opens as (and matches) a native notebook tab, not a text editor.
    const existingTab = taskTabs(task).find(
      t => t.filePath === filePath && (t.type === type || (type === 'editor' && t.type === 'notebook'))
    )
    if (existingTab) {
      setActiveTab(projectId, taskId, existingTab.id)
      return
    }

    addTab(projectId, taskId, pane, type === 'editor' && isNotebookFile(filePath) ? 'notebook' : type, filePath)
  }, [addTab, setActiveTab])

  const openOrFocusDiffTab = useCallback((projectId: string, taskId: string, pane: PaneRef, filePath: string) => {
    openOrFocusFileTab('diff', projectId, taskId, pane, filePath)
  }, [openOrFocusFileTab])

  const openOrFocusEditorTab = useCallback((projectId: string, taskId: string, pane: PaneRef, filePath: string) => {
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
    splitTabRight,
    setPaneWidths,
    openOrFocusDiffTab,
    openOrFocusEditorTab
  }
}

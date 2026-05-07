import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import { useMetaHeld } from '../hooks/useMetaHeld'
import { useGitStatus } from '../hooks/useGitStatus'
import { buildWindowTitle } from '../hooks/useAppState'
import { isRemoteProject, isShellCommandProject } from '../../shared/types'
import Pane from './Pane'
import TunnelPopup from './TunnelPopup'
import { ProjectHome } from './ProjectHome'
import { getPaneFromValue, resolvePaneForMenuAction, type PaneSide } from './paneFocus'
import type { TabDragState, TabDropTarget } from './tabDrag'
import type { TunnelConfig, TunnelState } from '../../shared/types'

function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

export default function ContentArea(): React.ReactElement {
  const {
    projects,
    selectedProject,
    selectedTask,
    selectedProjectId,
    selectedTaskId,
    toggleSplit,
    setSplitRatio,
    getProjectDir,
    setActiveTab,
    addTab,
    removeTab,
    reopenClosedTab,
    fileBrowserOpen,
    toggleFileBrowser,
    zoomTerminal,
    zoomBrowser,
    getTaskViewState,
    updateProject
  } = useApp()
  useMetaHeld()
  const panesRef = useRef<HTMLDivElement | null>(null)
  const focusedPaneRef = useRef<{ projectId: string | null; taskId: string | null; pane: PaneSide }>({
    projectId: null,
    taskId: null,
    pane: 'left'
  })
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const [tabDragState, setTabDragState] = useState<TabDragState | null>(null)
  const [tabDropTarget, setTabDropTarget] = useState<TabDropTarget | null>(null)
  const [sshStatuses, setSshStatuses] = useState<Record<string, string>>({})
  const [tunnelStates, setTunnelStates] = useState<Record<string, TunnelState>>({})
  const [tunnelPopupOpen, setTunnelPopupOpen] = useState(false)

  useEffect(() => {
    window.api.onSshStatusChanged((projectId: string, status: string) => {
      setSshStatuses(prev => ({ ...prev, [projectId]: status }))
    })
  }, [])

  useEffect(() => {
    window.api.onSshTunnelStatusChanged((projectId: string, state: TunnelState) => {
      setTunnelStates(prev => ({ ...prev, [projectId]: state }))
    })
  }, [])

  useEffect(() => {
    projects.filter(isRemoteProject).forEach(p => {
      window.api.sshStatus(p.id).then(status => {
        setSshStatuses(prev => ({ ...prev, [p.id]: status }))
      })
      window.api.sshTunnelStatus(p.id).then(state => {
        setTunnelStates(prev => ({ ...prev, [p.id]: state }))
      })
    })
  }, [projects])
  const isDragging = dragRatio !== null

  const hasProjectSelection = !!selectedProjectId
  const hasTaskSelection = !!selectedProjectId && !!selectedTaskId

  const rememberFocusedPane = useCallback((pane: PaneSide) => {
    focusedPaneRef.current = {
      projectId: selectedProjectId,
      taskId: selectedTaskId,
      pane
    }
  }, [selectedProjectId, selectedTaskId])

  useEffect(() => {
    setTabDragState(null)
    setTabDropTarget(null)
  }, [selectedProjectId, selectedTaskId])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((!e.metaKey && !e.ctrlKey) || !selectedProjectId || !selectedTaskId) return

      const digit = e.code.match(/^Digit([1-9])$/)?.[1]
      if (!digit) return

      const project = projects.find(p => p.id === selectedProjectId)
      const task = project?.tasks.find(t => t.id === selectedTaskId)
      if (!task) return
      const taskView = getTaskViewState(task)

      const index = parseInt(digit, 10) - 1
      const pane: 'left' | 'right' = e.shiftKey ? 'right' : 'left'
      const tabs = task.tabs[pane]
      const tab = tabs[index]

      if (tab) {
        e.preventDefault()
        setActiveTab(selectedProjectId, selectedTaskId, pane, tab.id)
        rememberFocusedPane(pane)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [projects, selectedProjectId, selectedTaskId, setActiveTab, rememberFocusedPane, getTaskViewState])

  // Menu shortcut handlers (Cmd+W, Cmd+Shift+T, Cmd+R, Cmd+T)
  useEffect(() => {
    const getActivePaneFromDom = (): PaneSide | null => {
      const activeElement = typeof document !== 'undefined' ? document.activeElement : null
      const paneElement = typeof Element !== 'undefined' && activeElement instanceof Element
        ? activeElement.closest<HTMLElement>('[data-pane]')
        : null
      return getPaneFromValue(paneElement?.dataset.pane)
    }

    const getRememberedPane = (): PaneSide | null => {
      const fallbackPane = focusedPaneRef.current
      if (fallbackPane.projectId === selectedProjectId && fallbackPane.taskId === selectedTaskId) {
        return fallbackPane.pane
      }
      return null
    }

    const getActiveTabInfo = () => {
      if (!selectedProjectId || !selectedTaskId) return null
      const project = projects.find(p => p.id === selectedProjectId)
      const task = project?.tasks.find(t => t.id === selectedTaskId)
      if (!task) return null
      const taskView = getTaskViewState(task)
      const pane = resolvePaneForMenuAction(taskView.splitOpen, getActivePaneFromDom(), getRememberedPane())
      const activeTabId = taskView.activeTab[pane]
      const activeTab = activeTabId ? task.tabs[pane].find(t => t.id === activeTabId) : null
      return { project, task, pane, activeTabId, activeTab }
    }

    const cleanupClose = window.api.onMenuCloseTab(() => {
      const info = getActiveTabInfo()
      if (selectedProjectId && selectedTaskId && info?.activeTabId) {
        removeTab(selectedProjectId, selectedTaskId, info.pane, info.activeTabId)
      }
    })

    const cleanupReopenClosed = window.api.onMenuReopenClosedTab(() => {
      const restoredPane = reopenClosedTab()
      if (restoredPane) {
        rememberFocusedPane(restoredPane)
      }
    })

    const cleanupReload = window.api.onMenuReloadTab(() => {
      const info = getActiveTabInfo()
      if (info?.activeTab?.type === 'browser' && info.activeTabId) {
        window.dispatchEvent(new CustomEvent('reload-browser-tab', { detail: { tabId: info.activeTabId } }))
        return
      }
      if ((info?.activeTab?.type === 'diff' || info?.activeTab?.type === 'editor') && info.activeTabId) {
        window.dispatchEvent(new CustomEvent('reload-file-tab', { detail: { tabId: info.activeTabId } }))
      }
    })

    const cleanupNewTerminal = window.api.onMenuNewTerminal(() => {
      if (!selectedProjectId || !selectedTaskId) return
      const pane = getActiveTabInfo()?.pane ?? 'left'
      addTab(selectedProjectId, selectedTaskId, pane, 'terminal')
      rememberFocusedPane(pane)
    })

    const handleZoom = (direction: 'in' | 'out' | 'reset') => {
      const info = getActiveTabInfo()
      if (info?.activeTab?.type === 'browser') {
        zoomBrowser(direction)
      } else {
        zoomTerminal(direction)
      }
    }

    const cleanupZoomIn = window.api.onMenuZoomIn(() => handleZoom('in'))
    const cleanupZoomOut = window.api.onMenuZoomOut(() => handleZoom('out'))
    const cleanupZoomReset = window.api.onMenuZoomReset(() => handleZoom('reset'))

    return () => {
      cleanupClose()
      cleanupReopenClosed()
      cleanupReload()
      cleanupNewTerminal()
      cleanupZoomIn()
      cleanupZoomOut()
      cleanupZoomReset()
    }
  }, [projects, selectedProjectId, selectedTaskId, addTab, removeTab, reopenClosedTab, zoomTerminal, zoomBrowser, rememberFocusedPane, getTaskViewState])

  const handleDividerMouseDown = useCallback(
    (projectId: string, taskId: string) => (e: React.MouseEvent) => {
      e.preventDefault()
      const container = panesRef.current
      if (!container) return

      const computeRatio = (clientX: number): number => {
        const rect = container.getBoundingClientRect()
        return Math.min(0.85, Math.max(0.15, (clientX - rect.left) / rect.width))
      }

      const onMouseMove = (ev: MouseEvent): void => {
        setDragRatio(computeRatio(ev.clientX))
      }

      const onMouseUp = (ev: MouseEvent): void => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        const finalRatio = computeRatio(ev.clientX)
        setDragRatio(null)
        setSplitRatio(projectId, taskId, finalRatio)
      }

      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [setSplitRatio]
  )

  const handleTunnelSave = useCallback(async (tunnel: TunnelConfig) => {
    if (!selectedProjectId || !selectedProject?.ssh) return
    updateProject(selectedProjectId, { tunnel })
    if (sshStatuses[selectedProjectId] === 'connected') {
      await window.api.sshSetTunnel(selectedProjectId, selectedProject.ssh, tunnel)
      return
    }
    setTunnelStates(prev => ({ ...prev, [selectedProjectId]: { status: 'inactive' } }))
  }, [selectedProject, selectedProjectId, sshStatuses, updateProject])

  const handleTunnelClear = useCallback(async () => {
    if (!selectedProjectId || !selectedProject?.ssh) return
    updateProject(selectedProjectId, { tunnel: undefined })
    if (sshStatuses[selectedProjectId] === 'connected') {
      await window.api.sshSetTunnel(selectedProjectId, selectedProject.ssh, null)
      return
    }
    setTunnelStates(prev => ({ ...prev, [selectedProjectId]: { status: 'inactive' } }))
  }, [selectedProject, selectedProjectId, sshStatuses, updateProject])

  const selectedTunnelState = selectedProjectId ? tunnelStates[selectedProjectId] : undefined
  const selectedTaskView = selectedTask ? getTaskViewState(selectedTask) : null
  const windowBarTitle = buildWindowTitle(selectedProject?.name ?? null, selectedTask?.name ?? null)
  const selectedProjectDir = selectedTask?.workspace
    ? joinPath(selectedTask.workspace.worktreePath, selectedTask.workspace.relativeProjectPath)
    : selectedProject?.directory ?? ''
  const canToggleFileBrowser = !!selectedProject
    && !isRemoteProject(selectedProject)
    && !isShellCommandProject(selectedProject)
    && !!selectedProject.directory
  const shouldShowGitSummary = !!selectedProject
    && !isRemoteProject(selectedProject)
    && !isShellCommandProject(selectedProject)
    && !!selectedProjectDir
  const gitStatus = useGitStatus(selectedProjectDir, shouldShowGitSummary)
  const gitSummary = gitStatus?.summary ?? null
  const hasGitSummary = !!gitSummary && (gitSummary.added > 0 || gitSummary.deleted > 0)
  const baseTunnelClasses = 'bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-0.5 rounded-sm text-[15px] leading-none inline-flex items-center justify-center hover:bg-surface-3 hover:text-text [-webkit-app-region:no-drag]'
  const tunnelButtonClassName = selectedProject && isRemoteProject(selectedProject)
    ? [
        baseTunnelClasses,
        selectedTunnelState?.status === 'error'
          ? 'text-red-400'
          : selectedProject.tunnel && selectedTunnelState?.status === 'active'
            ? 'text-accent-400'
            : ''
      ].filter(Boolean).join(' ')
    : baseTunnelClasses

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {selectedProject && (
        <div className="content-toolbar flex items-center justify-between gap-1.5 px-2 py-0.5 bg-surface-2 border-b border-border [-webkit-app-region:drag]">
          <div className="flex items-center gap-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-text-muted" title={windowBarTitle}>
            <span className="text-text font-semibold">{selectedProject.name}</span>
            {selectedTask && (
              <>
                <span className="text-text-muted"> / </span>
                <span className="text-text-muted">{selectedTask.name}</span>
              </>
            )}
            {hasGitSummary && gitSummary && (
              <span
                className="inline-flex items-center gap-1.5 ml-1.5 [font-variant-numeric:tabular-nums]"
                title={`${gitSummary.added} added, ${gitSummary.deleted} removed`}
              >
                {gitSummary.added > 0 && (
                  <span className="text-emerald-400">+{gitSummary.added}</span>
                )}
                {gitSummary.deleted > 0 && (
                  <span className="text-red-400">-{gitSummary.deleted}</span>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
          {isRemoteProject(selectedProject) && (
            <button
              className={tunnelButtonClassName}
              onClick={() => setTunnelPopupOpen(true)}
              title="Tunnel"
            >
              &#8596;
            </button>
          )}
          {canToggleFileBrowser && (
            <button
              className={`bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-0.5 rounded-sm text-[14px] leading-none inline-flex items-center justify-center hover:bg-surface-3 hover:text-text [-webkit-app-region:no-drag] translate-y-px${fileBrowserOpen ? ' text-accent-400' : ''}`}
              onClick={() => toggleFileBrowser()}
              title={fileBrowserOpen ? 'Close file browser (⌘⇧E)' : 'Open file browser (⌘⇧E)'}
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor"><path d="M1 1H14V14H1Z M2 2V13H9V2Z"/></svg>
            </button>
          )}
          {selectedTask && (
            <button
              className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-0.5 rounded-sm text-[14px] leading-none inline-flex items-center justify-center hover:bg-surface-3 hover:text-text [-webkit-app-region:no-drag]"
              onClick={() => toggleSplit(selectedProject.id, selectedTask.id)}
              title={selectedTaskView?.splitOpen ? 'Close split' : 'Split right'}
            >
              {selectedTaskView?.splitOpen ? '\u25E7' : '\u2B12'}
            </button>
          )}
          </div>
        </div>
      )}

      {!hasProjectSelection && (
        <div className="flex-1 flex items-center justify-center text-text-muted text-[14px]">Select or create a task to get started</div>
      )}
      {hasProjectSelection && !hasTaskSelection && selectedProjectId && (
        <ProjectHome projectId={selectedProjectId} />
      )}
      {projects.flatMap((project) =>
        project.tasks.map((task) => {
          const isVisible = project.id === selectedProjectId && task.id === selectedTaskId
          const taskView = getTaskViewState(task)
          const isSplitOpen = taskView.splitOpen
          const ratio = dragRatio ?? taskView.splitRatio ?? 0.5
          const effectiveDir = task.workspace
            ? joinPath(task.workspace.worktreePath, task.workspace.relativeProjectPath)
            : getProjectDir(project)
          return (
            <div
              key={`${project.id}-${task.id}`}
              className="flex-1 flex-col overflow-hidden relative"
              style={{ display: isVisible ? 'flex' : 'none' }}
            >
              <div className="flex-1 flex overflow-hidden relative" ref={isVisible ? panesRef : undefined}>
                {isDragging && <div className="absolute inset-0 z-10 cursor-col-resize" />}
                {isRemoteProject(project) && sshStatuses[project.id] !== 'connected' && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-[100]">
                    <div className="flex flex-col items-center gap-3 text-text text-[14px]">
                      <span className="text-[32px] text-red-400">&#9888;</span>
                      <span>SSH connection lost</span>
                      <button
                        className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-accent-500 text-accent-50 hover:bg-accent-400 disabled:opacity-50 cursor-pointer border-0"
                        onClick={() => {
                          if (project.ssh) {
                            window.api.sshConnect(project.id, project.ssh).catch(() => {})
                          }
                        }}
                      >
                        {sshStatuses[project.id] === 'connecting' ? 'Connecting...' : 'Reconnect'}
                      </button>
                    </div>
                  </div>
                )}
                <Pane
                  tabs={task.tabs.left}
                  activeTabId={taskView.activeTab.left}
                  taskVisible={isVisible}
                  pane="left"
                  projectId={project.id}
                  taskId={task.id}
                  projectDir={effectiveDir}
                  sshConfig={project.ssh}
                  shellCommand={project.shellCommand}
                  aiToolArgs={project.aiToolArgs}
                  style={isSplitOpen ? { flex: 'none', width: `calc(${ratio * 100}% - 1.5px)` } : undefined}
                  onPaneFocus={rememberFocusedPane}
                  tabDragState={tabDragState}
                  tabDropTarget={tabDropTarget}
                  onTabDragStateChange={setTabDragState}
                  onTabDropTargetChange={setTabDropTarget}
                  onTabDragComplete={rememberFocusedPane}
                />
                {isSplitOpen && (
                  <>
                    <div
                      className="w-[3px] shrink-0 bg-border cursor-col-resize hover:bg-accent-400 active:bg-accent-400"
                      onMouseDown={handleDividerMouseDown(project.id, task.id)}
                    />
                    <Pane
                      tabs={task.tabs.right}
                      activeTabId={taskView.activeTab.right}
                      taskVisible={isVisible}
                      pane="right"
                      projectId={project.id}
                      taskId={task.id}
                      projectDir={effectiveDir}
                      sshConfig={project.ssh}
                      shellCommand={project.shellCommand}
                      aiToolArgs={project.aiToolArgs}
                      style={{ flex: 'none', width: `calc(${(1 - ratio) * 100}% - 1.5px)` }}
                      onPaneFocus={rememberFocusedPane}
                      tabDragState={tabDragState}
                      tabDropTarget={tabDropTarget}
                      onTabDragStateChange={setTabDragState}
                      onTabDropTargetChange={setTabDropTarget}
                      onTabDragComplete={rememberFocusedPane}
                    />
                  </>
                )}
              </div>
            </div>
          )
        })
      )}
      {tunnelPopupOpen && selectedProject && isRemoteProject(selectedProject) && (
        <TunnelPopup
          project={selectedProject}
          tunnelState={selectedTunnelState}
          onSave={handleTunnelSave}
          onClear={handleTunnelClear}
          onClose={() => setTunnelPopupOpen(false)}
        />
      )}
    </div>
  )
}

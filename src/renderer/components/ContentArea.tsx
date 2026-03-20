import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import { useMetaHeld } from '../hooks/useMetaHeld'
import { isRemoteProject } from '../../shared/types'
import Pane from './Pane'
import TunnelPopup from './TunnelPopup'
import { getPaneFromValue, resolvePaneForMenuAction, type PaneSide } from './paneFocus'
import type { TabDragState, TabDropTarget } from './tabDrag'
import type { TunnelConfig, TunnelState } from '../../shared/types'
import './ContentArea.css'

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
      if (!e.metaKey || !selectedProjectId || !selectedTaskId) return

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

  // Menu shortcut handlers (Cmd+W, Cmd+R, Cmd+T)
  useEffect(() => {
    if (!selectedProjectId || !selectedTaskId) return

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
      if (info?.activeTabId) {
        removeTab(selectedProjectId!, selectedTaskId!, info.pane, info.activeTabId)
      }
    })

    const cleanupReload = window.api.onMenuReloadTab(() => {
      const info = getActiveTabInfo()
      if (info?.activeTab?.type === 'browser' && info.activeTabId) {
        window.dispatchEvent(new CustomEvent('reload-browser-tab', { detail: { tabId: info.activeTabId } }))
      }
      // Do nothing for terminal/AI tabs
    })

    const cleanupNewTerminal = window.api.onMenuNewTerminal(() => {
      const pane = getActiveTabInfo()?.pane ?? 'left'
      addTab(selectedProjectId!, selectedTaskId!, pane, 'terminal')
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
      cleanupReload()
      cleanupNewTerminal()
      cleanupZoomIn()
      cleanupZoomOut()
      cleanupZoomReset()
    }
  }, [projects, selectedProjectId, selectedTaskId, addTab, removeTab, zoomTerminal, zoomBrowser, rememberFocusedPane, getTaskViewState])

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
  const tunnelButtonClassName = selectedProject && isRemoteProject(selectedProject)
    ? [
        'content-toolbar-btn',
        'tunnel-btn',
        selectedTunnelState?.status === 'error'
          ? 'tunnel-btn-error'
          : selectedProject.tunnel && selectedTunnelState?.status === 'active'
            ? 'tunnel-btn-active'
            : ''
      ].filter(Boolean).join(' ')
    : 'content-toolbar-btn tunnel-btn'

  return (
    <div className="content-area">
      {selectedProject && (
        <div className="content-toolbar">
          {isRemoteProject(selectedProject) && (
            <button
              className={tunnelButtonClassName}
              onClick={() => setTunnelPopupOpen(true)}
              title="Tunnel"
            >
              &#8596;
            </button>
          )}
          {selectedTask && (
            <button
              className="content-toolbar-btn split-btn"
              onClick={() => toggleSplit(selectedProject.id, selectedTask.id)}
              title={selectedTaskView?.splitOpen ? 'Close split' : 'Split right'}
            >
              {selectedTaskView?.splitOpen ? '\u25E7' : '\u2B12'}
            </button>
          )}
        </div>
      )}

      {!hasProjectSelection && (
        <div className="content-empty">Select or create a task to get started</div>
      )}
      {hasProjectSelection && !hasTaskSelection && (
        <div className="content-empty">Select or create a task to get started</div>
      )}
      {projects.flatMap((project) =>
        project.tasks.map((task) => {
          const isVisible = project.id === selectedProjectId && task.id === selectedTaskId
          const taskView = getTaskViewState(task)
          const ratio = dragRatio ?? taskView.splitRatio ?? 0.5
          const effectiveDir = task.workspace
            ? joinPath(task.workspace.worktreePath, task.workspace.relativeProjectPath)
            : getProjectDir(project)
          return (
            <div
              key={`${project.id}-${task.id}`}
              className="content-task"
              style={{ display: isVisible ? 'flex' : 'none' }}
            >
              <div className="content-panes" ref={isVisible ? panesRef : undefined}>
                {isDragging && <div className="pane-drag-overlay" />}
                {isRemoteProject(project) && sshStatuses[project.id] !== 'connected' && (
                  <div className="content-disconnected-overlay">
                    <div className="content-disconnected-message">
                      <span className="content-disconnected-icon">&#9888;</span>
                      <span>SSH connection lost</span>
                      <button
                        className="add-remote-btn add-remote-btn-primary"
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
                  pane="left"
                  projectId={project.id}
                  taskId={task.id}
                  projectDir={effectiveDir}
                  sshConfig={project.ssh}
                  shellCommand={project.shellCommand}
                  aiToolArgs={project.aiToolArgs}
                  style={task.splitOpen ? { flex: 'none', width: `calc(${ratio * 100}% - 1.5px)` } : undefined}
                  onPaneFocus={rememberFocusedPane}
                  tabDragState={tabDragState}
                  tabDropTarget={tabDropTarget}
                  onTabDragStateChange={setTabDragState}
                  onTabDropTargetChange={setTabDropTarget}
                  onTabDragComplete={rememberFocusedPane}
                />
                {taskView.splitOpen && (
                  <>
                    <div
                      className="pane-divider"
                      onMouseDown={handleDividerMouseDown(project.id, task.id)}
                    />
                    <Pane
                      tabs={task.tabs.right}
                      activeTabId={taskView.activeTab.right}
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

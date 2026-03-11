import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import { isRemoteProject } from '../../shared/types'
import Pane from './Pane'
import './ContentArea.css'

export default function ContentArea(): React.ReactElement {
  const { projects, selectedProjectId, selectedTaskId, toggleSplit, setSplitRatio, getProjectDir, setActiveTab, addTab, removeTab, zoomTerminal, zoomBrowser } = useApp()
  const panesRef = useRef<HTMLDivElement | null>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const [sshStatuses, setSshStatuses] = useState<Record<string, string>>({})

  useEffect(() => {
    window.api.onSshStatusChanged((projectId: string, status: string) => {
      setSshStatuses(prev => ({ ...prev, [projectId]: status }))
    })
  }, [])

  useEffect(() => {
    projects.filter(isRemoteProject).forEach(p => {
      window.api.sshStatus(p.id).then(status => {
        setSshStatuses(prev => ({ ...prev, [p.id]: status }))
      })
    })
  }, [projects])
  const isDragging = dragRatio !== null

  const hasSelection = selectedProjectId && selectedTaskId

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || !selectedProjectId || !selectedTaskId) return

      const digit = e.code.match(/^Digit([1-9])$/)?.[1]
      if (!digit) return

      const project = projects.find(p => p.id === selectedProjectId)
      const task = project?.tasks.find(t => t.id === selectedTaskId)
      if (!task) return

      const index = parseInt(digit, 10) - 1
      const pane: 'left' | 'right' = e.shiftKey ? 'right' : 'left'
      const tabs = task.tabs[pane]
      const tab = tabs[index]

      if (tab) {
        e.preventDefault()
        setActiveTab(selectedProjectId, selectedTaskId, pane, tab.id)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [projects, selectedProjectId, selectedTaskId, setActiveTab])

  // Menu shortcut handlers (Cmd+W, Cmd+R, Cmd+T)
  useEffect(() => {
    if (!selectedProjectId || !selectedTaskId) return

    const getActiveTabInfo = () => {
      const project = projects.find(p => p.id === selectedProjectId)
      const task = project?.tasks.find(t => t.id === selectedTaskId)
      if (!task) return null
      // Use left pane's active tab by default
      const pane: 'left' | 'right' = 'left'
      const activeTabId = task.activeTab[pane]
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
      addTab(selectedProjectId!, selectedTaskId!, 'left', 'terminal')
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
  }, [projects, selectedProjectId, selectedTaskId, addTab, removeTab, zoomTerminal, zoomBrowser])

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

  return (
    <div className="content-area">
      {!hasSelection && (
        <div className="content-empty">Select or create a task to get started</div>
      )}
      {projects.flatMap((project) =>
        project.tasks.map((task) => {
          const isVisible = project.id === selectedProjectId && task.id === selectedTaskId
          const ratio = dragRatio ?? task.splitRatio ?? 0.5
          return (
            <div
              key={`${project.id}-${task.id}`}
              className="content-task"
              style={{ display: isVisible ? 'flex' : 'none' }}
            >
              <div className="content-toolbar">
                <button
                  className="split-btn"
                  onClick={() => toggleSplit(project.id, task.id)}
                  title={task.splitOpen ? 'Close split' : 'Split right'}
                >
                  {task.splitOpen ? '\u25E7' : '\u2B12'}
                </button>
              </div>
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
                  activeTabId={task.activeTab.left}
                  pane="left"
                  projectId={project.id}
                  taskId={task.id}
                  projectDir={getProjectDir(project)}
                  sshConfig={project.ssh}
                  shellCommand={project.shellCommand}
                  aiToolArgs={project.aiToolArgs}
                  style={task.splitOpen ? { flex: 'none', width: `calc(${ratio * 100}% - 1.5px)` } : undefined}
                />
                {task.splitOpen && (
                  <>
                    <div
                      className="pane-divider"
                      onMouseDown={handleDividerMouseDown(project.id, task.id)}
                    />
                    <Pane
                      tabs={task.tabs.right}
                      activeTabId={task.activeTab.right}
                      pane="right"
                      projectId={project.id}
                      taskId={task.id}
                      projectDir={getProjectDir(project)}
                      sshConfig={project.ssh}
                      shellCommand={project.shellCommand}
                      aiToolArgs={project.aiToolArgs}
                      style={{ flex: 'none', width: `calc(${(1 - ratio) * 100}% - 1.5px)` }}
                    />
                  </>
                )}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

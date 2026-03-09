import React, { useCallback, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import Pane from './Pane'
import './ContentArea.css'

export default function ContentArea(): React.ReactElement {
  const { projects, selectedProjectId, selectedTaskId, toggleSplit, setSplitRatio, getProjectDir } = useApp()
  const panesRef = useRef<HTMLDivElement | null>(null)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const isDragging = dragRatio !== null

  const hasSelection = selectedProjectId && selectedTaskId

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
      {projects.map((project) =>
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
                <Pane
                  tabs={task.tabs.left}
                  activeTabId={task.activeTab.left}
                  pane="left"
                  projectId={project.id}
                  taskId={task.id}
                  projectDir={getProjectDir(project)}
                  sshConfig={project.ssh}
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

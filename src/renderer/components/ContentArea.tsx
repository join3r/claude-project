import React from 'react'
import { useApp } from '../context/AppContext'
import Pane from './Pane'
import './ContentArea.css'

export default function ContentArea(): React.ReactElement {
  const { projects, selectedProjectId, selectedTaskId, toggleSplit } = useApp()

  const hasSelection = selectedProjectId && selectedTaskId

  return (
    <div className="content-area">
      {!hasSelection && (
        <div className="content-empty">Select or create a task to get started</div>
      )}
      {projects.map((project) =>
        project.tasks.map((task) => {
          const isVisible = project.id === selectedProjectId && task.id === selectedTaskId
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
              <div className="content-panes">
                <Pane
                  tabs={task.tabs.left}
                  activeTabId={task.activeTab.left}
                  pane="left"
                />
                {task.splitOpen && (
                  <>
                    <div className="pane-divider" />
                    <Pane
                      tabs={task.tabs.right}
                      activeTabId={task.activeTab.right}
                      pane="right"
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

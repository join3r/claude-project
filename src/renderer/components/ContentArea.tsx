import React from 'react'
import { useApp } from '../context/AppContext'
import Pane from './Pane'
import './ContentArea.css'

export default function ContentArea(): React.ReactElement {
  const { selectedProject, selectedTask, toggleSplit } = useApp()

  if (!selectedTask || !selectedProject) {
    return (
      <div className="content-area">
        <div className="content-empty">Select or create a task to get started</div>
      </div>
    )
  }

  return (
    <div className="content-area">
      <div className="content-toolbar">
        <button
          className="split-btn"
          onClick={() => toggleSplit(selectedProject.id, selectedTask.id)}
          title={selectedTask.splitOpen ? 'Close split' : 'Split right'}
        >
          {selectedTask.splitOpen ? '\u25E7' : '\u2B12'}
        </button>
      </div>
      <div className="content-panes">
        <Pane
          tabs={selectedTask.tabs.left}
          activeTabId={selectedTask.activeTab.left}
          pane="left"
        />
        {selectedTask.splitOpen && (
          <>
            <div className="pane-divider" />
            <Pane
              tabs={selectedTask.tabs.right}
              activeTabId={selectedTask.activeTab.right}
              pane="right"
            />
          </>
        )}
      </div>
    </div>
  )
}

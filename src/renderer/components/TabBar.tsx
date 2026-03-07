import React from 'react'
import { useApp } from '../context/AppContext'
import type { Tab } from '../../shared/types'
import './TabBar.css'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  pane: 'left' | 'right'
}

export default function TabBar({ tabs, activeTabId, pane }: Props): React.ReactElement {
  const { selectedProject, selectedTask, addTab, removeTab, setActiveTab } = useApp()
  if (!selectedProject || !selectedTask) return <div className="tab-bar" />

  const handleAdd = (type: 'terminal' | 'browser') => {
    addTab(selectedProject.id, selectedTask.id, pane, type)
  }

  return (
    <div className="tab-bar">
      <div className="tab-list">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'tab-active' : ''}`}
            onClick={() => setActiveTab(selectedProject.id, selectedTask.id, pane, tab.id)}
          >
            <span className="tab-icon">{tab.type === 'terminal' ? '>' : '\u25C9'}</span>
            <span className="tab-title">{tab.title}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation()
                removeTab(selectedProject.id, selectedTask.id, pane, tab.id)
              }}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
      <div className="tab-actions">
        <button className="tab-add-btn" onClick={() => handleAdd('terminal')} title="New terminal">
          &gt;_
        </button>
        <button className="tab-add-btn" onClick={() => handleAdd('browser')} title="New browser">
          &#9673;
        </button>
      </div>
    </div>
  )
}

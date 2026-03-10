import React from 'react'
import { useApp } from '../context/AppContext'
import { useTabStatus } from '../context/TabStatusContext'
import { AI_TAB_TYPES, isShellCommandProject } from '../../shared/types'
import type { Tab, TabType } from '../../shared/types'
import './TabBar.css'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  pane: 'left' | 'right'
}

function tabIcon(type: TabType): string {
  if (type === 'terminal') return '>'
  if (type === 'browser') return '\u25C9'
  if (type === 'claude') return '\u2726'
  if (type === 'codex') return '\u25EB'
  if (type === 'opencode') return '\u25C7'
  return '>'
}

function TabStatusIndicator({ tabId }: { tabId: string }): React.ReactElement | null {
  const status = useTabStatus(tabId)
  if (!status) return null
  return <span className={`tab-status tab-status-${status}`} />
}

export default function TabBar({ tabs, activeTabId, pane }: Props): React.ReactElement {
  const { selectedProject, selectedTask, addTab, removeTab, setActiveTab, config } = useApp()
  if (!selectedProject || !selectedTask) return <div className="tab-bar" />

  const handleAdd = (type: TabType) => {
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
            <span className="tab-icon">{tabIcon(tab.type)}</span>
            <TabStatusIndicator tabId={tab.id} />
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
        {config?.enableClaude && selectedProject && !isShellCommandProject(selectedProject) && (
          <button className="tab-add-btn" onClick={() => handleAdd('claude')} title="New Claude Code">
            &#10022;
          </button>
        )}
        {config?.enableCodex && selectedProject && !isShellCommandProject(selectedProject) && (
          <button className="tab-add-btn" onClick={() => handleAdd('codex')} title="New Codex">
            &#9707;
          </button>
        )}
        {config?.enableOpencode && selectedProject && !isShellCommandProject(selectedProject) && (
          <button className="tab-add-btn" onClick={() => handleAdd('opencode')} title="New OpenCode">
            &#9671;
          </button>
        )}
      </div>
    </div>
  )
}

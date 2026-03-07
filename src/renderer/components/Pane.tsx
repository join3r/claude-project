import React from 'react'
import TabBar from './TabBar'
import type { Tab } from '../../shared/types'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  pane: 'left' | 'right'
}

export default function Pane({ tabs, activeTabId, pane }: Props): React.ReactElement {
  const activeTab = tabs.find((t) => t.id === activeTabId)

  return (
    <div className="pane">
      <TabBar tabs={tabs} activeTabId={activeTabId} pane={pane} />
      <div className="pane-content">
        {activeTab ? (
          <div className="tab-content-placeholder">
            {activeTab.type} &mdash; {activeTab.title} (id: {activeTab.id})
          </div>
        ) : (
          <div className="pane-empty">Open a terminal or browser tab</div>
        )}
      </div>
    </div>
  )
}

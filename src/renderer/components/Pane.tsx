import React from 'react'
import TabBar from './TabBar'
import TerminalTab from './TerminalTab'
import BrowserTab from './BrowserTab'
import type { Tab } from '../../shared/types'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  pane: 'left' | 'right'
}

export default function Pane({ tabs, activeTabId, pane }: Props): React.ReactElement {
  return (
    <div className="pane">
      <TabBar tabs={tabs} activeTabId={activeTabId} pane={pane} />
      <div className="pane-content">
        {tabs.length === 0 && (
          <div className="pane-empty">Open a terminal or browser tab</div>
        )}
        {tabs.map((tab) => {
          if (tab.type === 'terminal') {
            return (
              <TerminalTab
                key={tab.id}
                tabId={tab.id}
                visible={tab.id === activeTabId}
              />
            )
          }
          if (tab.type === 'browser') {
            return (
              <BrowserTab
                key={tab.id}
                tabId={tab.id}
                visible={tab.id === activeTabId}
                initialUrl={tab.url}
              />
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

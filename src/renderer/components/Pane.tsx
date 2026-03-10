import React from 'react'
import TabBar from './TabBar'
import TerminalTab from './TerminalTab'
import BrowserTab from './BrowserTab'
import AiToolTab from './AiToolTab'
import { AI_TAB_TYPES } from '../../shared/types'
import type { Tab, AiTabType, SshConfig, ShellCommandConfig } from '../../shared/types'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  pane: 'left' | 'right'
  projectId: string
  taskId: string
  projectDir: string
  sshConfig?: SshConfig
  shellCommand?: ShellCommandConfig
  style?: React.CSSProperties
}

export default function Pane({ tabs, activeTabId, pane, projectId, taskId, projectDir, sshConfig, shellCommand, style }: Props): React.ReactElement {
  return (
    <div className="pane" style={style}>
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
                projectId={projectId}
                sshConfig={sshConfig}
                shellCommand={shellCommand}
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
                projectId={projectId}
                taskId={taskId}
                pane={pane}
              />
            )
          }
          if ((AI_TAB_TYPES as readonly string[]).includes(tab.type)) {
            return (
              <AiToolTab
                key={tab.id}
                tabId={tab.id}
                toolType={tab.type as AiTabType}
                visible={tab.id === activeTabId}
                sessionId={tab.sessionId}
                pane={pane}
                projectId={projectId}
                taskId={taskId}
                projectDir={projectDir}
                sshConfig={sshConfig}
              />
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

import React from 'react'
import { MessageSquare } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { isShellCommandProject } from '../../shared/types'
import type { TabType } from '../../shared/types'
import { formatShortcutForApp } from '../../shared/shortcut-label'
import type { PaneRef } from './paneFocus'

const btnCls = 'bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs font-mono hover:bg-surface-3 hover:text-text transition-colors duration-(--motion-fast)'

/**
 * The "new terminal / browser / agent" buttons. They sit at the end of each tab
 * bar, and in the content toolbar while a task shows no tab bar (one tab or none).
 */
export default function NewTabButtons({
  projectId,
  taskId,
  pane,
  className = ''
}: {
  projectId: string
  taskId: string
  pane: PaneRef
  className?: string
}): React.ReactElement {
  const { selectedProject, addTab, config } = useApp()
  const claudeChatDefault = config?.claudeDefaultView === 'chat'
  const agentsAllowed = !!selectedProject && !isShellCommandProject(selectedProject)
  const add = (type: TabType) => { addTab(projectId, taskId, pane, type) }

  return (
    <div className={`flex gap-0.5 [-webkit-app-region:no-drag] ${className}`}>
      <button className={btnCls} onClick={() => add('terminal')} title={`New terminal (${formatShortcutForApp('CmdOrCtrl+T')})`}>
        &gt;_
      </button>
      <button className={btnCls} onClick={() => add('browser')} title="New browser">
        &#9673;
      </button>
      {config?.enableClaude && agentsAllowed && (
        <>
          <button className={btnCls} onClick={() => add(claudeChatDefault ? 'claude-chat' : 'claude')} title={claudeChatDefault ? 'New Claude chat' : 'New Claude Code'}>
            &#10022;
          </button>
          <button className={`${btnCls} inline-flex items-center`} onClick={() => add(claudeChatDefault ? 'claude' : 'claude-chat')} title={claudeChatDefault ? 'New Claude Code (terminal)' : 'New Claude chat'}>
            {claudeChatDefault ? <span>&gt;&#10022;</span> : <MessageSquare size={12} strokeWidth={2} />}
          </button>
        </>
      )}
      {config?.enableCodex && agentsAllowed && (
        <button className={btnCls} onClick={() => add('codex')} title="New Codex">
          &#9707;
        </button>
      )}
      {config?.enablePi && agentsAllowed && (
        <button className={btnCls} onClick={() => add('pi')} title="New Pi">
          &#960;
        </button>
      )}
    </div>
  )
}

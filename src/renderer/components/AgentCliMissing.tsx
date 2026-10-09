import React from 'react'
import { AI_TAB_META, type AiTabType } from '../../shared/types'
import { AGENT_INSTALLERS, agentCliCommand, agentInstallScript } from '../../shared/agent-clis'
import { useApp } from '../context/AppContext'
import { serverName, useServersState } from '../serversState'
import { noteAgentInstall, refreshServerAgentClis, type ServerAgentClis } from '../agentClis'
import { setPendingRun } from './terminalStartup'

interface Props {
  serverId: string
  agent: AiTabType
  /** What the server said, with this window's install of it. */
  entry: ServerAgentClis
  projectId: string
  taskId: string
  /** The agent's tab: the installer's terminal opens beside it. */
  tabId: string
}

const btnCls = 'h-(--ctl-h) px-3 rounded-md border border-border bg-surface-2 text-sm text-text cursor-pointer hover:bg-surface-3 disabled:opacity-50 disabled:cursor-default'
const primaryCls = 'h-(--ctl-h) px-3 rounded-md border-0 bg-accent text-accent-ink text-sm font-medium cursor-pointer hover:brightness-105 disabled:opacity-50 disabled:cursor-default'

/**
 * In place of an agent or chat tab whose CLI a DevTool server doesn't have:
 * "Claude Code isn't installed on <server> · Install", with why. Install runs
 * the agent's official installer in a terminal tab on that server, next to this
 * one; when it ends, the server runs its login shell again and is asked again,
 * and this tab starts the agent once it is there.
 */
export default function AgentCliMissing({ serverId, agent, entry, projectId, taskId, tabId }: Props): React.ReactElement {
  const { addTab } = useApp()
  const servers = useServersState()
  const name = serverName(serverId, servers)
  const label = AI_TAB_META[agent].label
  const command = agentCliCommand(agent)
  const install = entry.installs[agent]
  const running = install?.state === 'running'
  const checking = entry.checking

  const startInstall = (): void => {
    const tab = addTab(projectId, taskId, { withTab: tabId }, 'terminal', { title: `Install ${label}` })
    if (!tab) return
    setPendingRun(tab.id, agentInstallScript(agent))
    noteAgentInstall(serverId, agent, { tabId: tab.id, projectId, taskId })
  }

  let detail: React.ReactNode
  if (running) {
    detail = <>The installer is running in the <span className="text-text">Install {label}</span> tab. This tab starts {label} when it is done.</>
  } else if (install?.state === 'exited' && install.exitCode !== 0) {
    detail = <span className="text-danger">The installer failed with exit code {install.exitCode}. Its tab shows why.</span>
  } else if (install?.state === 'exited') {
    detail = <>The installer finished, but <code className="font-mono">{command}</code> still isn't on {name}'s login PATH. A new login may need a profile change the installer printed.</>
  } else {
    detail = <><code className="font-mono">{command}</code> isn't on {name}'s login PATH. Install runs <code className="font-mono break-all">{AGENT_INSTALLERS[agent].command}</code> there, in a terminal tab.</>
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg p-6" data-testid="agent-cli-missing">
      <div className="max-w-[520px] flex flex-col gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3 shadow-pop">
        <div className="text-md text-text font-medium">{label} isn't installed on {name}</div>
        <div className="text-sm text-text-muted leading-relaxed">{detail}</div>
        {entry.error && <div className="text-sm text-danger">{entry.error}</div>}
        <div className="flex items-center gap-2">
          <button type="button" className={primaryCls} disabled={running} onClick={startInstall}>
            {install ? 'Install again' : 'Install'}
          </button>
          <button
            type="button"
            className={btnCls}
            disabled={checking}
            onClick={() => { void refreshServerAgentClis(serverId, { refreshEnv: true }) }}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>
    </div>
  )
}

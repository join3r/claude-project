// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ServersState, ServerStatus } from '../src/shared/servers'
import type { AgentClisReport } from '../src/shared/agent-clis'

void React

const addTab = vi.fn()
vi.mock('../src/renderer/context/AppContext', () => ({
  useApp: () => ({ addTab })
}))

import { resetServersStateForTests } from '../src/renderer/serversState'
import { agentCliGate, getServerAgentClis, refreshServerAgentClis, resetAgentClisForTests, type ServerAgentClis } from '../src/renderer/agentClis'
import AgentCliMissing from '../src/renderer/components/AgentCliMissing'
import { peekPendingRun } from '../src/renderer/components/terminalStartup'

function server(patch: Partial<ServerStatus> = {}): ServerStatus {
  return { id: 'srvA', name: 'box', state: 'online', pairedAt: 1, lastSeen: 2, build: null, host: null, ...patch }
}

function state(servers: ServerStatus[]): ServersState {
  return { relay: { kind: 'online' }, servers, invite: null }
}

function report(found: Partial<Record<'claude' | 'codex' | 'pi', boolean>>): AgentClisReport {
  return {
    platform: 'linux',
    checkedAt: 1,
    clis: {
      claude: { found: !!found.claude },
      codex: { found: !!found.codex },
      pi: { found: !!found.pi }
    }
  }
}

let ptyExit: ((tabId: string, exitCode: number) => void) | null = null

beforeEach(() => {
  addTab.mockReset()
  ptyExit = null
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'win32',
    hostAgentClis: vi.fn().mockResolvedValue(report({ codex: true })),
    hostRefreshEnv: vi.fn().mockResolvedValue({ path: '/usr/bin' }),
    onPtyExit: vi.fn((callback: (tabId: string, exitCode: number) => void) => { ptyExit = callback }),
    serversGetState: vi.fn().mockResolvedValue(state([server()])),
    onServersStateChanged: vi.fn(() => () => {})
  }
  resetServersStateForTests(state([server()]))
  resetAgentClisForTests()
})

afterEach(() => {
  cleanup()
})

describe('a server\'s agent CLIs', () => {
  const entry = (patch: Partial<ServerAgentClis>): ServerAgentClis => ({ report: null, checking: false, error: null, installs: {}, ...patch })

  it('lets a tab start, wait, or say the CLI is missing', () => {
    expect(agentCliGate(null, 'claude')).toEqual({ state: 'ready' })
    expect(agentCliGate(entry({ checking: true }), 'claude')).toEqual({ state: 'checking' })
    expect(agentCliGate(entry({}), 'claude')).toEqual({ state: 'checking' })
    expect(agentCliGate(entry({ report: report({ claude: true }) }), 'claude')).toEqual({ state: 'ready' })
    expect(agentCliGate(entry({ report: report({}) }), 'pi')).toEqual({ state: 'missing', status: { found: false } })
    // An older server can't say: its tabs start as they always did.
    expect(agentCliGate(entry({ error: 'unsupported' }), 'claude')).toEqual({ state: 'ready' })
  })

  it('asks the server once per check, and runs its login shell again when asked to', async () => {
    await Promise.all([refreshServerAgentClis('srvA'), refreshServerAgentClis('srvA')])
    expect(window.api.hostAgentClis).toHaveBeenCalledTimes(1)
    expect(window.api.hostRefreshEnv).not.toHaveBeenCalled()
    expect(getServerAgentClis('srvA').report?.clis.codex.found).toBe(true)

    await refreshServerAgentClis('srvA', { refreshEnv: true })
    expect(window.api.hostRefreshEnv).toHaveBeenCalledWith('srvA')
    expect(window.api.hostAgentClis).toHaveBeenCalledTimes(2)

    vi.mocked(window.api.hostAgentClis).mockRejectedValueOnce(new Error("Error invoking remote method 'host-agent-clis': Error: unsupported"))
    await refreshServerAgentClis('srvA')
    expect(getServerAgentClis('srvA')).toMatchObject({ error: 'unsupported', checking: false })
  })

  it('installs a missing CLI in a terminal tab on the server, then checks again with a fresh login env', async () => {
    await refreshServerAgentClis('srvA')
    addTab.mockImplementation(() => ({ id: 'install-tab', type: 'terminal', title: 'Install Claude Code' }))
    const view = render(<AgentCliMissing serverId="srvA" agent="claude" entry={getServerAgentClis('srvA')} projectId="p" taskId="t" tabId="claude-tab" />)
    expect(screen.getByText("Claude Code isn't installed on box")).toBeTruthy()
    expect(screen.getByText('curl -fsSL https://claude.ai/install.sh | bash')).toBeTruthy()

    fireEvent.click(screen.getByText('Install'))
    expect(addTab).toHaveBeenCalledWith('p', 't', { withTab: 'claude-tab' }, 'terminal', { title: 'Install Claude Code' })
    expect(peekPendingRun('install-tab')).toContain("cmd='curl -fsSL https://claude.ai/install.sh | bash'")
    expect(getServerAgentClis('srvA').installs.claude).toEqual({ tabId: 'install-tab', projectId: 'p', taskId: 't', state: 'running' })
    view.rerender(<AgentCliMissing serverId="srvA" agent="claude" entry={getServerAgentClis('srvA')} projectId="p" taskId="t" tabId="claude-tab" />)
    expect(screen.getByText(/The installer is running in the/)).toBeTruthy()

    // The installer ends; the server reads its login env again and has claude now.
    vi.mocked(window.api.hostAgentClis).mockResolvedValueOnce(report({ claude: true }))
    await act(async () => { ptyExit?.('some-other-tab', 0) })
    expect(window.api.hostRefreshEnv).not.toHaveBeenCalled()
    await act(async () => { ptyExit?.('install-tab', 0) })
    await waitFor(() => expect(getServerAgentClis('srvA').report?.clis.claude.found).toBe(true))
    expect(window.api.hostRefreshEnv).toHaveBeenCalledWith('srvA')
    expect(getServerAgentClis('srvA').installs.claude).toMatchObject({ state: 'exited', exitCode: 0 })
  })

  it('says how a failed install ended', async () => {
    await refreshServerAgentClis('srvA')
    addTab.mockImplementation(() => ({ id: 'install-2', type: 'terminal', title: 'Install Pi' }))
    const view = render(<AgentCliMissing serverId="srvA" agent="pi" entry={getServerAgentClis('srvA')} projectId="p" taskId="t" tabId="pi-tab" />)
    fireEvent.click(screen.getByText('Install'))
    await act(async () => { ptyExit?.('install-2', 7) })
    view.rerender(<AgentCliMissing serverId="srvA" agent="pi" entry={getServerAgentClis('srvA')} projectId="p" taskId="t" tabId="pi-tab" />)
    expect(screen.getByText('The installer failed with exit code 7. Its tab shows why.')).toBeTruthy()
    expect(screen.getByText('Install again')).toBeTruthy()
  })
})

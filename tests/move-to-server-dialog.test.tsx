// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ServerStatus, ServersState, SshHostProbeResult } from '../src/shared/servers'
import type { Project } from '../src/shared/types'
import { resetServersStateForTests } from '../src/renderer/serversState'
import { fixtureProject } from './helpers/streams-fixtures'

void React

// The SSH terminal brings xterm; here it only records what it was asked to run.
const terminal = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), session: null as null | { id: string; target: string } }))
vi.mock('../src/renderer/components/servers/useSshInstallTerminal', () => ({
  useSshInstallTerminal: () => ({
    hostRef: { current: null },
    theme: { background: '#000' },
    shown: terminal.start.mock.calls.length > 0,
    session: terminal.session,
    ended: null,
    error: null,
    start: terminal.start,
    stop: terminal.stop
  })
}))

import MoveToServerDialog from '../src/renderer/components/servers/MoveToServerDialog'

const ID_A = 'a'.repeat(32)
const ID_B = 'b'.repeat(32)
const RELAY = 'ws://192.168.1.101:8787'

const api = {
  serversSshProbe: vi.fn(),
  socksProxyStatus: vi.fn(),
  serversMoveProject: vi.fn(),
  serversCreateInvite: vi.fn(),
  serversCancelInvite: vi.fn(),
  mobileGetState: vi.fn(),
  onMobileStateChanged: vi.fn(() => () => {})
}

const server = (id: string, over: Partial<ServerStatus> = {}): ServerStatus => ({
  id,
  name: id === ID_A ? 'devtool-srv-test' : 'other',
  state: 'online',
  pairedAt: 1,
  lastSeen: 1,
  build: null,
  host: { os: 'linux', arch: 'arm64', hostname: id === ID_A ? 'devtool-srv-test' : 'other-box', node: '24.21.0', user: 'join3r' },
  ...over
})

function push(state: Partial<ServersState>): void {
  act(() => resetServersStateForTests({ relay: { kind: 'online' }, servers: [], invite: null, ...state }))
}

function project(over: Partial<Project> = {}): Project {
  return { ...fixtureProject({ id: 'p-ssh', name: 'repo', directory: '' }), ssh: { host: 'orb', port: 22, username: 'devtool-srv-test', remoteDir: '/home/join3r/repo' }, ...over }
}

function probeAnswer(answer: SshHostProbeResult): void {
  api.serversSshProbe.mockResolvedValue(answer)
}

const onClose = vi.fn()

/** The button once the host check is in (it is disabled until then). */
async function ready(name: string): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const button = screen.getByRole('button', { name }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    return button
  })
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.onMobileStateChanged.mockImplementation(() => () => {})
  api.mobileGetState.mockResolvedValue({ enabled: false, relayUrl: RELAY, desktopName: 'mac', connection: { kind: 'off' }, invite: null, pending: null, devices: [] })
  api.socksProxyStatus.mockResolvedValue({ enabled: false })
  api.serversMoveProject.mockImplementation(async (projectId: string, serverId: string) => ({ projectId, serverId, directory: '/home/join3r/repo', restarted: [] }))
  api.serversCreateInvite.mockResolvedValue({ oneLiner: 'curl …', token: 't', expiresAt: Date.now() + 900_000 })
  api.serversCancelInvite.mockResolvedValue(undefined)
  terminal.start.mockReset()
  terminal.stop.mockReset()
  terminal.session = null
  onClose.mockReset()
  ;(window as unknown as { api: typeof api }).api = api
})

afterEach(() => {
  cleanup()
})

describe('Move to a DevTool server', () => {
  it('reuses the server already paired on that host, with no install', async () => {
    push({ servers: [server(ID_A), server(ID_B)] })
    probeAnswer({ ok: true, probe: { hostname: 'devtool-srv-test', user: 'join3r', installed: true, serverId: ID_A, relayUrl: RELAY } })
    render(<MoveToServerDialog project={project()} onClose={onClose} />)
    expect(await screen.findByText('It goes to devtool-srv-test, which already runs on devtool-srv-test@orb. Nothing gets installed.')).toBeTruthy()
    expect(screen.getByTestId('move-summary').textContent).toContain('Open terminals and agent tabs restart on the server, and agents resume their sessions.')
    fireEvent.click(await ready('Move'))
    await waitFor(() => expect(api.serversMoveProject).toHaveBeenCalledWith('p-ssh', ID_A))
    expect(await screen.findByTestId('move-done')).toBeTruthy()
    expect(api.serversCreateInvite).not.toHaveBeenCalled()
    expect(terminal.start).not.toHaveBeenCalled()
  })

  it('waits for the paired server to come online before moving', async () => {
    push({ servers: [server(ID_A, { state: 'offline' })] })
    probeAnswer({ ok: true, probe: { hostname: 'devtool-srv-test', user: 'join3r', installed: true, serverId: ID_A } })
    render(<MoveToServerDialog project={project()} onClose={onClose} />)
    fireEvent.click(await ready('Move'))
    expect(await screen.findByText('Waiting for devtool-srv-test to come online…')).toBeTruthy()
    expect(api.serversMoveProject).not.toHaveBeenCalled()
    push({ servers: [server(ID_A)] })
    await waitFor(() => expect(api.serversMoveProject).toHaveBeenCalledWith('p-ssh', ID_A))
  })

  it('installs over the project\'s own SSH connection, then moves to the new server', async () => {
    push({ servers: [] })
    probeAnswer({ ok: true, probe: { hostname: 'devtool-srv-test', user: 'join3r', installed: false } })
    render(<MoveToServerDialog project={project()} onClose={onClose} />)
    expect(await screen.findByText('DevTool installs on devtool-srv-test@orb if needed.')).toBeTruthy()
    fireEvent.click(await ready('Install and move'))
    await waitFor(() => expect(terminal.start).toHaveBeenCalledWith({ target: { host: 'orb', user: 'devtool-srv-test' }, projectId: 'p-ssh' }))
    expect(api.serversCreateInvite).toHaveBeenCalledTimes(1)
    // The installer pairs, the bootstrap installs, the service connects.
    push({ servers: [server(ID_A, { installing: true })], invite: { oneLiner: '', token: 't', expiresAt: Date.now() + 60_000, status: 'paired', serverId: ID_A } })
    expect(api.serversMoveProject).not.toHaveBeenCalled()
    push({ servers: [server(ID_A)], invite: { oneLiner: '', token: 't', expiresAt: Date.now() + 60_000, status: 'paired', serverId: ID_A } })
    await waitFor(() => expect(api.serversMoveProject).toHaveBeenCalledWith('p-ssh', ID_A))
    cleanup()
    // Closing cancels the invite it made.
    expect(api.serversCancelInvite).toHaveBeenCalled()
  })

  it('explains a server on another relay and offers no move', async () => {
    push({ servers: [] })
    probeAnswer({ ok: true, probe: { hostname: 'devtool-srv-test', user: 'join3r', installed: true, relayUrl: 'wss://relay.example.com' } })
    render(<MoveToServerDialog project={project()} onClose={onClose} />)
    expect((await screen.findByTestId('move-other-relay')).textContent).toBe(
      `devtool-srv-test@orb runs a DevTool server on another relay (wss://relay.example.com). This computer uses ${RELAY}, so it can't pair with that server. Switch the relay in Settings, Relay, or run devtool-server uninstall on devtool-srv-test@orb first.`
    )
    expect((screen.getByRole('button', { name: /Move/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('asks which server when the host could not be checked', async () => {
    push({ servers: [server(ID_B), server(ID_A)] })
    probeAnswer({ ok: false, error: 'Permission denied (publickey)' })
    render(<MoveToServerDialog project={project()} onClose={onClose} />)
    expect(await screen.findByText("DevTool couldn't check the host (Permission denied (publickey)). Pick the server that runs there, or install one.")).toBeTruthy()
    const options = screen.getAllByRole('radio')
    expect(options.map(o => o.textContent)).toEqual([
      expect.stringContaining('other'),
      expect.stringContaining('devtool-srv-test'),
      expect.stringContaining('Install DevTool on devtool-srv-test@orb')
    ])
    // Nothing matched the SSH host: install is the default, a pick changes it.
    await waitFor(() => expect(screen.getAllByRole('radio')[2].getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(screen.getAllByRole('radio')[1])
    fireEvent.click(await ready('Move'))
    await waitFor(() => expect(api.serversMoveProject).toHaveBeenCalledWith('p-ssh', ID_A))
  })

  it('says why a move failed and tries again', async () => {
    push({ servers: [server(ID_A)] })
    probeAnswer({ ok: true, probe: { hostname: 'devtool-srv-test', user: 'join3r', installed: true, serverId: ID_A } })
    api.serversMoveProject.mockRejectedValueOnce(new Error("Error invoking remote method 'servers-move-project': Error: The server has no folder /home/join3r/repo"))
    render(<MoveToServerDialog project={project()} onClose={onClose} />)
    fireEvent.click(await ready('Move'))
    expect((await screen.findByTestId('move-error')).textContent).toBe('The server has no folder /home/join3r/repo')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.serversMoveProject).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('move-done')).toBeTruthy()
  })

  it('mentions the tunnel and the SOCKS proxy that close', async () => {
    push({ servers: [] })
    api.socksProxyStatus.mockResolvedValue({ enabled: true, port: 1080 })
    probeAnswer({ ok: true, probe: { hostname: 'devtool-srv-test', user: 'join3r', installed: false } })
    render(<MoveToServerDialog project={project({ tunnel: { host: 'localhost', sourcePort: 3000, destinationPort: 3000 } })} onClose={onClose} />)
    expect(await screen.findByText('Its SSH tunnel and SOCKS proxy close. Browser tabs reach ports on devtool-srv-test@orb through the server instead.')).toBeTruthy()
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ServerStatus, ServersState } from '../src/shared/servers'
import { resetServersStateForTests } from '../src/renderer/serversState'

void React

// The SSH panel brings xterm; here it only shows the shared status block.
vi.mock('../src/renderer/components/servers/SshInstallPanel', () => ({
  default: ({ status }: { status: React.ReactNode }) => <div data-testid="ssh-panel">{status}</div>
}))

import AddServerDialog from '../src/renderer/components/servers/AddServerDialog'
import AddServerProject from '../src/renderer/components/servers/AddServerProject'

const ID = 'b'.repeat(32)
const T0 = Date.UTC(2026, 9, 9, 10, 0, 0)
const EXP = T0 + 15 * 60_000
const ONE_LINER = 'curl -fsSL https://devtool.awantech.sk/install | DEVTOOL_TOKEN=AQtoken.24.21.0 sh'

const api = {
  serversCreateInvite: vi.fn(),
  serversCancelInvite: vi.fn(),
  serversPairCode: vi.fn(),
  serverDiscoverRepos: vi.fn(),
  mobileGetState: vi.fn(),
  onMobileStateChanged: vi.fn(() => () => {}),
  pickFile: vi.fn()
}

const server = (over: Partial<ServerStatus> = {}): ServerStatus =>
  ({ id: ID, name: 'box', state: 'connecting', pairedAt: T0, lastSeen: T0, build: null, host: null, ...over })
const waiting = (over: Partial<ServersState> = {}): ServersState => ({
  relay: { kind: 'online' },
  servers: [],
  invite: { oneLiner: ONE_LINER, token: 'AQtoken.24.21.0', expiresAt: EXP, status: 'waiting' },
  ...over
})

function push(state: ServersState): void {
  act(() => resetServersStateForTests(state))
}

const onAddProjects = vi.fn()
const onChooseFolder = vi.fn()
const onClose = vi.fn()

function mount() {
  return render(
    <AddServerDialog
      sshTargets={[]}
      existingDirectories={() => new Set()}
      onAddProjects={onAddProjects}
      onChooseFolder={onChooseFolder}
      onClose={onClose}
    />
  )
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

const title = () => screen.getByTestId('install-status-title').textContent

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
  vi.setSystemTime(T0)
  ;(window as unknown as { api: typeof api }).api = api
  api.serversCreateInvite.mockReset().mockImplementation(async () => {
    const expiresAt = Date.now() + 15 * 60_000
    resetServersStateForTests(waiting({ invite: { ...waiting().invite!, expiresAt } }))
    return { oneLiner: ONE_LINER, token: 'AQtoken.24.21.0', expiresAt }
  })
  api.serversCancelInvite.mockReset().mockResolvedValue(waiting({ invite: null }))
  api.serversPairCode.mockReset()
  api.serverDiscoverRepos.mockReset().mockResolvedValue({ root: '/home/me', repos: [{ name: 'app', path: '/home/me/app' }], truncated: false })
  api.mobileGetState.mockReset().mockResolvedValue({ relayUrl: 'wss://relay.devtool.awantech.sk', devices: [], connection: { kind: 'online' } })
  onAddProjects.mockReset()
  onChooseFolder.mockReset()
  onClose.mockReset()
  resetServersStateForTests({ relay: { kind: 'idle' }, servers: [], invite: null })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetServersStateForTests()
})

describe('Add server dialog', () => {
  it('shows only the one-liner, copies it, and follows the install to the setup step', async () => {
    mount()
    await flush()
    expect(api.serversCreateInvite).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('install-command').textContent).toBe(ONE_LINER)
    expect(screen.getByTestId('install-expiry').textContent).toBe('Works once · expires in 15:00')
    expect(title()).toBe('Waiting for the server…')

    fireEvent.click(screen.getByRole('button', { name: /Copy command/ }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ONE_LINER)

    // The installer paired with the invite; the command goes away and the status follows the server.
    push(waiting({ invite: { ...waiting().invite!, status: 'paired', serverId: ID }, servers: [server()] }))
    expect(screen.queryByTestId('install-command')).toBeNull()
    expect(title()).toBe('Connecting to box…')

    push(waiting({ invite: { ...waiting().invite!, status: 'paired', serverId: ID }, servers: [server({ state: 'online', installing: true, upload: { sent: 3, total: 4 } })] }))
    expect(title()).toBe('Installing DevTool on box… 75%')

    push(waiting({ invite: null, servers: [server({ state: 'offline', installing: true })] }))
    expect(title()).toBe('Starting DevTool on box…')

    push(waiting({
      invite: null,
      servers: [server({ state: 'online', host: { os: 'linux', arch: 'arm64', hostname: 'devbox', node: '24.21.0' }, build: { version: '0.6.0', commit: 'abc', builtAt: '', bundleSha: 'x' } })]
    }))
    expect(screen.getByRole('heading', { name: 'Set up box' })).toBeTruthy()
    expect(title()).toBe('Connected to devbox')
    expect(screen.getByTestId('install-status').textContent).toContain('Linux arm64, DevTool 0.6.0')

    await flush()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    expect(onAddProjects).toHaveBeenCalledWith(ID, [{ name: 'app', directory: '/home/me/app' }])
    expect(screen.getByText('Added one project to the sidebar.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }))
    expect(onChooseFolder).toHaveBeenCalledWith(ID)
  })

  it('cancels the invite when it closes', async () => {
    const view = mount()
    await flush()
    view.unmount()
    expect(api.serversCancelInvite).toHaveBeenCalledTimes(1)
  })

  it('counts down, then offers a new command once the old one expired', async () => {
    mount()
    await flush()
    act(() => { vi.advanceTimersByTime(14 * 60_000 + 30_000) })
    expect(screen.getByTestId('install-expiry').textContent).toBe('Works once · expires in 0:30')
    // Main drops the invite at its expiry.
    act(() => { vi.advanceTimersByTime(31_000) })
    push(waiting({ invite: null }))
    expect(title()).toBe('This command expired')
    expect(screen.queryByRole('button', { name: /Copy command/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New command' }))
    await flush()
    expect(api.serversCreateInvite).toHaveBeenCalledTimes(2)
    expect(title()).toBe('Waiting for the server…')
  })

  it('offers a new command when a phone pairing code took the offer slot', async () => {
    mount()
    await flush()
    push(waiting({ invite: null }))
    expect(title()).toBe('This command no longer works')
    expect(screen.getByText(/A phone pairing code took its place/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New command' }))
    await flush()
    expect(api.serversCreateInvite).toHaveBeenCalledTimes(2)
  })

  it('points at the server terminal when nothing connects for two minutes', async () => {
    mount()
    await flush()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.queryByText(/check the server's terminal/)).toBeNull()
    act(() => { vi.advanceTimersByTime(61_000) })
    expect(screen.getByText(/check the server's terminal for details/)).toBeTruthy()
  })

  it('says when the relay is unreachable', async () => {
    mount()
    await flush()
    push(waiting({ relay: { kind: 'offline', error: 'connect ECONNREFUSED' } }))
    expect(title()).toBe("Can't reach the relay")
  })

  it('pairs with a code from devtool-server pair and shows readable errors', async () => {
    mount()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'I have a code' }))
    const field = screen.getByLabelText('Pairing code')
    api.serversPairCode.mockRejectedValueOnce(new Error("Error invoking remote method 'servers-pair-code': PairingError: This pairing code has expired. Run devtool-server pair on the server again."))
    fireEvent.change(field, { target: { value: '  AQcode  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    await flush()
    expect(api.serversPairCode).toHaveBeenCalledWith('AQcode')
    expect(screen.getByText('This pairing code has expired. Run devtool-server pair on the server again.')).toBeTruthy()

    api.serversPairCode.mockImplementationOnce(async () => {
      resetServersStateForTests(waiting({ servers: [server()] }))
      return server()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    await flush()
    await flush()
    expect(title()).toBe('Connecting to box…')
    push(waiting({ servers: [server({ state: 'online' })] }))
    expect(screen.getByRole('heading', { name: 'Set up box' })).toBeTruthy()
  })

  it('Install over SSH keeps the status in its own view until the user moves on', async () => {
    mount()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Install over SSH…' }))
    expect(screen.getByTestId('ssh-panel')).toBeTruthy()
    expect(screen.getByText('Answer any ssh questions in the terminal above.')).toBeTruthy()
    // Going back to the command keeps the panel (and a running ssh) mounted, out of sight.
    fireEvent.click(screen.getByRole('button', { name: 'Back to the command' }))
    expect(screen.getByTestId('ssh-panel').parentElement?.className).toBe('hidden')
    expect(screen.getByTestId('install-command')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Install over SSH…' }))
    expect(screen.getByTestId('ssh-panel').parentElement?.className).toBe('contents')
    push(waiting({ invite: { ...waiting().invite!, status: 'paired', serverId: ID }, servers: [server({ state: 'online' })] }))
    // Connected, but the installer may still be printing: stay until "Set up".
    expect(screen.getByTestId('ssh-panel')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to the command' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Set up box' }))
    expect(screen.getByRole('heading', { name: 'Set up box' })).toBeTruthy()
  })
})

describe('Server project with no server paired', () => {
  it('offers Add server instead of an empty picker', () => {
    const onAddServer = vi.fn()
    render(<AddServerProject servers={[]} onAddServer={onAddServer} existingDirectories={() => new Set()} onAdd={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('no-servers').textContent).toContain('No servers yet')
    fireEvent.click(screen.getByRole('button', { name: 'Add server…' }))
    expect(onAddServer).toHaveBeenCalled()
  })
})

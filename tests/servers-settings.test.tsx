// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ServerStatus, ServersState } from '../src/shared/servers'
import type { MobileState } from '../src/shared/mobile'
import { resetServersStateForTests } from '../src/renderer/serversState'
import ServersSettings, { serverStateText } from '../src/renderer/components/settings/ServersSettings'
import RelaySettings from '../src/renderer/components/settings/RelaySettings'
import { paletteEvents } from '../src/renderer/palette/paletteEvents'

void React

const T0 = Date.UTC(2026, 9, 9, 10, 0, 0)
const id = (c: string) => c.repeat(32)
const build = { version: '0.6.0', commit: 'c4398705aaaa', builtAt: '2026-10-09T09:00:00Z', bundleSha: 'x' }
const host = { os: 'linux', arch: 'arm64', hostname: 'devtool-srv-test', node: '24.21.0' }
const server = (over: Partial<ServerStatus> = {}): ServerStatus =>
  ({ id: id('a'), name: 'box', state: 'online', pairedAt: T0, lastSeen: T0, build, host, ...over })

const mobile = (over: Partial<MobileState> = {}): MobileState => ({
  enabled: false,
  relayUrl: 'wss://relay.devtool.awantech.sk',
  connection: { kind: 'disabled' },
  invite: null,
  pending: null,
  devices: [],
  ...over
} as MobileState)

const api = {
  serversRename: vi.fn(),
  serversRemove: vi.fn(),
  serversRestart: vi.fn(),
  serversDeviceCode: vi.fn(),
  serversUpdate: vi.fn(),
  mobileGetState: vi.fn(),
  onMobileStateChanged: vi.fn(() => () => {}),
  mobileSetRelayUrl: vi.fn()
}

function servers(list: ServerStatus[], relay: ServersState['relay'] = { kind: 'online' }): void {
  act(() => resetServersStateForTests({ relay, servers: list, invite: null }))
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
  vi.setSystemTime(T0 + 5 * 60_000)
  ;(window as unknown as { api: typeof api }).api = api
  for (const fn of Object.values(api)) fn.mockReset()
  api.onMobileStateChanged.mockImplementation(() => () => {})
  api.mobileGetState.mockResolvedValue(mobile())
  api.serversRemove.mockResolvedValue({ uninstalled: true })
  api.serversRename.mockImplementation(async (_id: string, name: string) => server({ name }))
  api.serversRestart.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetServersStateForTests()
})

describe('Settings › Servers', () => {
  it('describes every state in plain words', () => {
    expect(serverStateText(server())).toEqual({ tone: 'online', label: 'Online' })
    expect(serverStateText(server({ state: 'connecting' }))).toMatchObject({ label: 'Connecting' })
    expect(serverStateText(server({ state: 'offline', error: 'The server went offline' }))).toMatchObject({ tone: 'offline', label: 'Offline', note: 'The server went offline' })
    expect(serverStateText(server({ state: 'updating' }))).toMatchObject({ tone: 'busy', label: 'Restarting into an update' })
    expect(serverStateText(server({ upload: { sent: 1, total: 4 } }))).toMatchObject({ label: 'Updating 25%' })
    expect(serverStateText(server({ installing: true }))).toMatchObject({ label: 'Installing' })
    expect(serverStateText(server({ state: 'incompatible', update: 'desktop' }))).toMatchObject({ tone: 'bad', label: 'Needs a newer DevTool' })
    expect(serverStateText(server({ state: 'incompatible', update: 'server' })).note).toMatch(/Run the install command on it again/)
    expect(serverStateText(server({ state: 'offline', problem: 'revoked' })).note).toMatch(/no longer accepts this computer/)
    expect(serverStateText(server({ state: 'offline', problem: 'unknown-device' })).note).toMatch(/devtool-server pair/)
    expect(serverStateText(server({ state: 'offline', problem: 'relay-too-old' }))).toMatchObject({ label: 'Relay too old' })
  })

  it('lists servers with build, machine, last seen and actions; offline ones can only be removed', async () => {
    render(<ServersSettings onOpenRelay={() => {}} />)
    servers([
      server(),
      server({ id: id('b'), name: 'old box', state: 'offline', lastSeen: T0 - 3 * 3600_000 }),
      server({ id: id('c'), name: 'new box', state: 'incompatible', update: 'desktop' })
    ], { kind: 'too-old', error: 'This relay is too old for servers' })
    await flush()
    const rows = screen.getAllByTestId('server-row')
    expect(rows).toHaveLength(3)
    const online = within(rows[0])
    expect(online.getByTestId('server-state').textContent).toBe('Online')
    expect(rows[0].textContent).toContain('DevTool 0.6.0 (c439870), devtool-srv-test, Linux arm64')
    expect((online.getByRole('button', { name: 'Add another device' }) as HTMLButtonElement).disabled).toBe(false)
    const offline = within(rows[1])
    expect(rows[1].textContent).toContain('Last seen 3 h ago')
    expect((offline.getByRole('button', { name: 'Add another device' }) as HTMLButtonElement).disabled).toBe(true)
    expect((offline.getByRole('button', { name: 'Update now' }) as HTMLButtonElement).disabled).toBe(true)
    expect(rows[2].textContent).toContain('Update DevTool here to use it.')
    expect(screen.getByTestId('relay-line').textContent).toContain('This relay is too old for servers')
  })

  it('renames inline, shows a device code with its expiry, updates and restarts into a ready update', async () => {
    render(<ServersSettings onOpenRelay={() => {}} />)
    servers([server({ updateReady: { version: '0.6.1', commit: 'def4567aaaa', builtAt: '2026-10-09T09:41:00Z' } })])
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Rename box' }))
    const field = screen.getByLabelText('Server name')
    fireEvent.change(field, { target: { value: 'orb box' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await flush()
    expect(api.serversRename).toHaveBeenCalledWith(id('a'), 'orb box')

    api.serversDeviceCode.mockResolvedValue({ code: 'AQdevicecode', expiresAt: Date.now() + 15 * 60_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Add another device' }))
    await flush()
    const code = screen.getByTestId('device-code')
    expect(code.textContent).toContain('AQdevicecode')
    expect(code.textContent).toContain('Works once · expires in 15:00')
    fireEvent.click(within(code).getByRole('button', { name: 'Copy' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('AQdevicecode')
    act(() => { vi.advanceTimersByTime(15 * 60_000 + 1000) })
    expect(screen.getByTestId('device-code').textContent).toContain('The code expired.')

    api.serversUpdate.mockResolvedValue({ upload: false, reason: 'same' })
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
    await flush()
    await flush()
    expect(screen.getByText('Already up to date.')).toBeTruthy()

    expect(screen.getByTestId('update-ready').textContent).toMatch(/^Update ready: DevTool 0\.6\.1 \(def4567\), built /)
    fireEvent.click(screen.getByRole('button', { name: 'Restart into update' }))
    await flush()
    expect(api.serversRestart).toHaveBeenCalledWith(id('a'))
  })

  it('Remove: uninstall is on for an online server, keep data off; the choices reach main', async () => {
    render(<ServersSettings onOpenRelay={() => {}} />)
    servers([server()])
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    const switches = within(screen.getByTestId('remove-options')).getAllByRole('switch')
    expect(switches.map(s => s.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(screen.getByText('Also uninstall DevTool from box')).toBeTruthy()
    fireEvent.click(switches[1])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Uninstall and remove' })) })
    expect(api.serversRemove).toHaveBeenCalledWith(id('a'), { uninstall: true, keepData: true })
  })

  it('Remove: switching uninstall off removes from this computer only', async () => {
    render(<ServersSettings onOpenRelay={() => {}} />)
    servers([server()])
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    fireEvent.click(within(screen.getByTestId('remove-options')).getAllByRole('switch')[0])
    expect(within(screen.getByTestId('remove-options')).getAllByRole('switch')).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })) })
    expect(api.serversRemove).toHaveBeenCalledWith(id('a'), {})
  })

  it('Remove: an offline server gets the command to run on it and is removed here only', async () => {
    render(<ServersSettings onOpenRelay={() => {}} />)
    servers([server({ state: 'offline' })])
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    expect(screen.queryByTestId('remove-options')).toBeNull()
    const offline = screen.getByTestId('remove-offline')
    expect(offline.textContent).toContain("box is offline, so DevTool can't uninstall it from here.")
    expect(offline.textContent).toContain('devtool-server uninstall')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })) })
    expect(api.serversRemove).toHaveBeenCalledWith(id('a'), {})
  })

  it('has an empty state that opens Add server', async () => {
    const opened = vi.fn()
    const off = paletteEvents.on('open-add-server', opened)
    render(<ServersSettings onOpenRelay={() => {}} />)
    servers([])
    fireEvent.click(within(screen.getByTestId('servers-empty')).getByRole('button', { name: 'Add server…' }))
    expect(opened).toHaveBeenCalled()
    off()
  })
})

describe('Settings › Relay', () => {
  it('saves a new relay at once when nothing is paired, and keeps the unencrypted warning', async () => {
    api.mobileSetRelayUrl.mockImplementation(async (url: string) => mobile({ relayUrl: url }))
    render(<RelaySettings />)
    servers([], { kind: 'idle' })
    await flush()
    const field = screen.getByLabelText('Relay address')
    fireEvent.change(field, { target: { value: 'ws://192.168.1.101:8787' } })
    expect(screen.getByText(/Unencrypted relay/)).toBeTruthy()
    fireEvent.keyDown(field, { key: 'Enter' })
    await flush()
    expect(api.mobileSetRelayUrl).toHaveBeenCalledWith('ws://192.168.1.101:8787')
    expect(screen.queryByTestId('relay-change-warning')).toBeNull()
  })

  it('warns before moving paired servers and phones to another relay', async () => {
    api.mobileGetState.mockResolvedValue(mobile({ devices: [{ id: id('d'), name: 'iPhone', pairedAt: T0, lastSeen: T0, online: false, push: false }] as MobileState['devices'] }))
    api.mobileSetRelayUrl.mockImplementation(async (url: string) => mobile({ relayUrl: url }))
    render(<RelaySettings />)
    servers([server(), server({ id: id('b') })])
    await flush()
    const field = screen.getByLabelText('Relay address')
    fireEvent.change(field, { target: { value: 'wss://relay.example.com' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.blur(field)
    expect(api.mobileSetRelayUrl).not.toHaveBeenCalled()
    const warning = screen.getByTestId('relay-change-warning')
    expect(warning.textContent).toContain('Change the relay for 2 servers and 1 phone?')
    expect(warning.textContent).toContain('go offline until you pair them again on the new relay')
    fireEvent.click(within(warning).getByRole('button', { name: 'Keep the current one' }))
    expect(screen.queryByTestId('relay-change-warning')).toBeNull()
    expect((screen.getByLabelText('Relay address') as HTMLInputElement).value).toBe('wss://relay.devtool.awantech.sk')

    fireEvent.change(field, { target: { value: 'wss://relay.example.com/' } })
    fireEvent.click(within(screen.getByTestId('relay-change-warning')).getByRole('button', { name: 'Change relay' }))
    await flush()
    expect(api.mobileSetRelayUrl).toHaveBeenCalledWith('wss://relay.example.com')
  })

  it('refuses an address that is not a relay', async () => {
    render(<RelaySettings />)
    servers([])
    await flush()
    const field = screen.getByLabelText('Relay address')
    fireEvent.change(field, { target: { value: 'https://relay.example.com' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByText('Use a ws:// or wss:// address.')).toBeTruthy()
    expect(api.mobileSetRelayUrl).not.toHaveBeenCalled()
  })
})

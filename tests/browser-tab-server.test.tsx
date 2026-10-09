// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import BrowserTab from '../src/renderer/components/BrowserTab'

void React

vi.mock('../src/renderer/context/AppContext', () => ({
  useApp: () => ({ updateTabUrl: vi.fn(), browserZoomFactor: 1, markTaskInteracted: vi.fn(), addTab: vi.fn() })
}))

vi.mock('../src/renderer/serversState', () => ({
  useServerStatus: (id: string | undefined) => (id ? { id, name: 'devbox', state: 'online' } : null)
}))

const SERVER = 'ab'.repeat(16)
const base = { tabId: 't1', initialUrl: 'http://localhost:8000/', projectId: 'p1', taskId: 'k1', serverId: SERVER }

/** Browser tabs of a DevTool server's project (plan step 9). */

let resolveProxy: (value: { port: number }) => void
let rejectProxy: (err: Error) => void

beforeEach(() => {
  ;(window as any).api = {
    serverBrowserProxy: vi.fn(() => new Promise((resolve, reject) => { resolveProxy = resolve; rejectProxy = reject })),
    serverBrowserProxyRelease: vi.fn().mockResolvedValue(undefined),
    onSocksProxyStatusChanged: vi.fn(() => () => {})
  }
})

afterEach(() => {
  cleanup()
})

describe('BrowserTab on a server project', () => {
  it('loads nothing until its session goes through the server, then shows "via <server>"', async () => {
    const { container } = render(<BrowserTab {...base} visible />)
    expect(container.querySelector('webview')).toBeNull()
    expect(screen.getByText('Connecting through devbox...')).toBeTruthy()
    expect((window as any).api.serverBrowserProxy).toHaveBeenCalledWith('p1', 't1')

    resolveProxy({ port: 50123 })
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    const webview = container.querySelector('webview')!
    expect(webview.getAttribute('partition')).toBe('persist:browser-p1')
    expect(webview.getAttribute('src')).toBe('http://localhost:8000/')
    expect(screen.getByText('via devbox')).toBeTruthy()
  })

  it('never falls back to a direct connection, and lets the user try again', async () => {
    const { container } = render(<BrowserTab {...base} visible />)
    rejectProxy(new Error("Error invoking remote method 'server-browser-proxy': Error: listen EADDRINUSE"))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('listen EADDRINUSE'))
    expect(container.querySelector('webview')).toBeNull()
    fireEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect((window as any).api.serverBrowserProxy).toHaveBeenCalledTimes(2))
  })

  it('waits for its first view, and lets go when it closes', async () => {
    const { rerender, unmount } = render(<BrowserTab {...base} visible={false} />)
    await new Promise((r) => setTimeout(r, 0))
    expect((window as any).api.serverBrowserProxy).not.toHaveBeenCalled()
    rerender(<BrowserTab {...base} visible />)
    expect((window as any).api.serverBrowserProxy).toHaveBeenCalledTimes(1)
    unmount()
    expect((window as any).api.serverBrowserProxyRelease).toHaveBeenCalledWith('p1', 't1')
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import BrowserTab from '../src/renderer/components/BrowserTab'

void React

vi.mock('../src/renderer/context/AppContext', () => ({
  useApp: () => ({
    updateTabUrl: vi.fn(),
    browserZoomFactor: 1,
    markTaskInteracted: vi.fn(),
    addTab: vi.fn()
  })
}))

const base = { tabId: 't1', initialUrl: 'https://example.com/', projectId: 'p1', taskId: 'k1', pane: 'left' as const }

beforeEach(() => {
  ;(window as any).api = {
    sshStatus: vi.fn().mockResolvedValue('connected'),
    socksProxyStatus: vi.fn().mockResolvedValue({ enabled: true, port: 1080 }),
    socksProxyEnable: vi.fn().mockResolvedValue(undefined),
    onSocksProxyStatusChanged: vi.fn(() => () => {})
  }
})

afterEach(() => {
  cleanup()
})

describe('BrowserTab lazy webview', () => {
  it('does not mount the webview until first shown, then keeps it mounted', () => {
    const { container, rerender } = render(<BrowserTab {...base} visible={false} />)
    expect(container.querySelector('webview')).toBeNull()

    rerender(<BrowserTab {...base} visible />)
    const webview = container.querySelector('webview')
    expect(webview?.getAttribute('src')).toBe('https://example.com/')

    rerender(<BrowserTab {...base} visible={false} />)
    expect(container.querySelector('webview')).toBe(webview)
  })

  it('mounts at once when it starts visible', () => {
    const { container } = render(<BrowserTab {...base} visible />)
    expect(container.querySelector('webview')).not.toBeNull()
  })

  it('reload requests before first view are a no-op', () => {
    render(<BrowserTab {...base} visible={false} />)
    expect(() => window.dispatchEvent(new CustomEvent('reload-browser-tab', { detail: { tabId: 't1' } }))).not.toThrow()
  })

  it('does not touch the SSH proxy for a remote tab until first shown', async () => {
    const sshConfig = { host: 'h', user: 'u' } as any
    const { container, rerender } = render(<BrowserTab {...base} visible={false} sshConfig={sshConfig} />)
    await new Promise(r => setTimeout(r, 0))
    expect((window as any).api.sshStatus).not.toHaveBeenCalled()
    expect(container.querySelector('webview')).toBeNull()

    rerender(<BrowserTab {...base} visible sshConfig={sshConfig} />)
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    expect((window as any).api.sshStatus).toHaveBeenCalledWith('p1')
  })
})

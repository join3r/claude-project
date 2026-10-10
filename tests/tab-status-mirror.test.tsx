// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { TabStatusProvider, useTabStatusStore, type TabStatusStore } from '../src/renderer/context/TabStatusContext'
import type { HostTabStatus } from '../src/shared/types'

// React import is required by the JSX runtime under vitest's default transform.
void React

function renderStore(): TabStatusStore {
  let store: TabStatusStore | null = null
  function Grab(): null {
    store = useTabStatusStore()
    return null
  }
  render(<TabStatusProvider><Grab /></TabStatusProvider>)
  return store!
}

describe('TabStatusStore.mirrorToMain', () => {
  afterEach(() => {
    cleanup()
    delete (window as { api?: unknown }).api
  })

  it('reports mirrored tabs to main (on register and on change) and nothing else', () => {
    const reportTabStatus = vi.fn().mockResolvedValue(undefined)
    ;(window as { api?: unknown }).api = { reportTabStatus }
    const store = renderStore()

    store.setStatus('codex', 'working')
    const stop = store.mirrorToMain('codex')
    store.setStatus('codex', 'attention')
    store.setStatus('codex', 'attention') // unchanged
    store.setStatus('claude', 'working') // not mirrored: hooks reach main on their own
    stop()
    store.setStatus('codex', null)

    expect(reportTabStatus.mock.calls).toEqual([['codex', 'working'], ['codex', 'attention']])
  })

  it('tolerates a window without the channel', () => {
    ;(window as { api?: unknown }).api = {}
    const store = renderStore()
    store.mirrorToMain('t')
    expect(() => store.setStatus('t', 'working')).not.toThrow()
  })
})

describe('TabStatusStore host statuses', () => {
  afterEach(() => {
    cleanup()
    delete (window as { api?: unknown }).api
  })

  function withHost(snapshot: Record<string, HostTabStatus>) {
    let push: ((tabId: string, entry: HostTabStatus) => void) | null = null
    ;(window as { api?: unknown }).api = {
      getTabStatuses: vi.fn().mockResolvedValue(snapshot),
      onTabHostStatus: (callback: typeof push) => { push = callback; return () => {} }
    }
    return { push: (tabId: string, entry: HostTabStatus) => act(() => push!(tabId, entry)) }
  }

  it('shows main\'s status for a tab this window has not set one for', async () => {
    const host = withHost({ queued: { status: 'working', since: 100 } })
    const store = renderStore()
    await act(async () => {})

    expect(store.getStatus('queued')).toBe('working')
    expect(store.getSinceSnapshot().queued).toBe(100)

    host.push('queued', { status: null, since: 200 })
    expect(store.getStatus('queued')).toBeNull()
    expect(store.getSnapshot()).toEqual({ queued: null })

    host.push('queued', { status: null, since: null }) // removed in main
    expect(store.getSnapshot()).toEqual({})
  })

  it('lets the window\'s own status win once it sets one', async () => {
    const host = withHost({})
    const store = renderStore()
    await act(async () => {})

    host.push('t', { status: 'working', since: 100 })
    act(() => store.setStatus('t', 'working'))
    expect(store.getSinceSnapshot().t).toBe(100) // taking over keeps when it began
    act(() => store.setStatus('t', null))
    host.push('t', { status: 'attention', since: 300 })
    expect(store.getStatus('t')).toBeNull()
  })

  it('a live update beats the snapshot', async () => {
    let resolve: (value: Record<string, HostTabStatus>) => void = () => {}
    let push: ((tabId: string, entry: HostTabStatus) => void) | null = null
    ;(window as { api?: unknown }).api = {
      getTabStatuses: () => new Promise(r => { resolve = r }),
      onTabHostStatus: (callback: typeof push) => { push = callback; return () => {} }
    }
    const store = renderStore()
    act(() => push!('t', { status: null, since: 300 }))
    await act(async () => resolve({ t: { status: 'working', since: 100 }, u: { status: 'attention', since: 50 } }))
    expect(store.getSnapshot()).toEqual({ t: null, u: 'attention' })
  })
})

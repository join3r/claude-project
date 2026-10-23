// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render, waitFor } from '@testing-library/react'
import { refetchStreamRuns, useAllStreamRuns } from '../src/renderer/streamRuns'
import type { StreamRunState } from '../src/shared/stream-run'

void React

describe('stream run store', () => {
  it('asks again for a project and drops runs its host no longer has', async () => {
    const running: StreamRunState = { status: 'running', command: 'x', startedAt: 1 }
    let answer: Record<string, StreamRunState> = { a: running, b: running }
    ;(window as any).api = {
      streamRunStates: vi.fn(async () => answer),
      onStreamRunState: vi.fn(() => () => {})
    }
    let seen: Record<string, StreamRunState> = {}
    function Probe() {
      seen = useAllStreamRuns(['p'])
      return null
    }
    render(<Probe />)
    await waitFor(() => expect(Object.keys(seen).sort()).toEqual(['a', 'b']))
    answer = { b: { ...running, startedAt: 2 } }
    refetchStreamRuns(['p'])
    await waitFor(() => expect(Object.keys(seen)).toEqual(['b']))
    expect(seen.b.startedAt).toBe(2)
  })
})

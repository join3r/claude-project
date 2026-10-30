import { describe, expect, it } from 'vitest'
import { createInteractionStampGate, INTERACTION_STAMP_INTERVAL_MS } from '../src/renderer/components/taskRecency'

describe('createInteractionStampGate', () => {
  it('exposes a 5 second window', () => {
    expect(INTERACTION_STAMP_INTERVAL_MS).toBe(5000)
  })

  it('allows the first call for a task', () => {
    const gate = createInteractionStampGate()
    expect(gate('task-a', 1000)).toBe(true)
  })

  it('throttles a second call inside the window', () => {
    const gate = createInteractionStampGate()
    expect(gate('task-a', 1000)).toBe(true)
    expect(gate('task-a', 1000 + INTERACTION_STAMP_INTERVAL_MS - 1)).toBe(false)
  })

  it('allows a call exactly at the window boundary', () => {
    const gate = createInteractionStampGate()
    expect(gate('task-a', 1000)).toBe(true)
    expect(gate('task-a', 1000 + INTERACTION_STAMP_INTERVAL_MS)).toBe(true)
  })

  it('tracks tasks independently', () => {
    const gate = createInteractionStampGate()
    expect(gate('task-a', 1000)).toBe(true)
    expect(gate('task-b', 1000)).toBe(true)
    expect(gate('task-a', 1500)).toBe(false)
    expect(gate('task-b', 1500)).toBe(false)
  })
})

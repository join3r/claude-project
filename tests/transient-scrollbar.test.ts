import { describe, expect, it } from 'vitest'
import { hasRecentScrollIntent, isTerminalScrollIntentKey } from '../src/renderer/components/transientScrollbar'

describe('transientScrollbar', () => {
  it('recognizes keys that indicate user-driven terminal scrolling', () => {
    expect(isTerminalScrollIntentKey('ArrowUp')).toBe(true)
    expect(isTerminalScrollIntentKey('PageDown')).toBe(true)
    expect(isTerminalScrollIntentKey('End')).toBe(true)
    expect(isTerminalScrollIntentKey('Enter')).toBe(false)
    expect(isTerminalScrollIntentKey('a')).toBe(false)
  })

  it('treats only recent input as scroll intent', () => {
    expect(hasRecentScrollIntent(1_000, 1_100)).toBe(true)
    expect(hasRecentScrollIntent(1_000, 1_251)).toBe(false)
    expect(hasRecentScrollIntent(1_000, 1_400, 500)).toBe(true)
  })
})

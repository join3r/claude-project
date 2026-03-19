import { describe, expect, it } from 'vitest'
import { getTabDropIndex, getTabReorderInsertIndex } from '../src/renderer/components/tabDrag'

describe('tab drag helpers', () => {
  const items = [
    { id: 'tab-a', index: 0, left: 0, width: 100 },
    { id: 'tab-b', index: 1, left: 100, width: 100 },
    { id: 'tab-c', index: 2, left: 200, width: 100 }
  ]

  it('computes insertion based on tab midpoints', () => {
    expect(getTabDropIndex(items, 20, 'tab-x')).toBe(0)
    expect(getTabDropIndex(items, 120, 'tab-x')).toBe(1)
    expect(getTabDropIndex(items, 160, 'tab-x')).toBe(2)
  })

  it('allows dropping at the end of the strip', () => {
    expect(getTabDropIndex(items, 320, 'tab-a')).toBe(3)
  })

  it('ignores the dragged tab when calculating same-pane positions', () => {
    expect(getTabDropIndex(items, 160, 'tab-b')).toBe(1)
    expect(getTabDropIndex(items, 260, 'tab-b')).toBe(3)
  })

  it('detects adjacent same-pane drops as no-ops', () => {
    expect(getTabReorderInsertIndex(1, 1)).toBeNull()
    expect(getTabReorderInsertIndex(1, 2)).toBeNull()
    expect(getTabReorderInsertIndex(2, 1)).toBe(1)
    expect(getTabReorderInsertIndex(1, 3)).toBe(2)
  })
})

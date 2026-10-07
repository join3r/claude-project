import { describe, expect, it } from 'vitest'
import { getBodyDropTarget, getTabDropIndex } from '../src/renderer/components/tabDrag'

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

  it('splits a pane when dropped near its edge and appends to it in the middle', () => {
    const rect = { left: 100, width: 400 }
    expect(getBodyDropTarget(1, rect, 120, 3)).toEqual({ kind: 'split', pane: 1, side: 'left', inBody: true })
    expect(getBodyDropTarget(1, rect, 490, 3)).toEqual({ kind: 'split', pane: 1, side: 'right', inBody: true })
    expect(getBodyDropTarget(1, rect, 300, 3)).toEqual({ kind: 'tab', pane: 1, index: 3, inBody: true })
  })

  it('caps the split zone on wide panes', () => {
    const wide = { left: 0, width: 2000 }
    expect(getBodyDropTarget(0, wide, 170, 1).kind).toBe('tab')
    expect(getBodyDropTarget(0, wide, 150, 1).kind).toBe('split')
  })
})

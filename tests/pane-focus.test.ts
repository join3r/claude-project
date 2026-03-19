import { describe, expect, it } from 'vitest'
import { getPaneFromValue, resolvePaneForMenuAction } from '../src/renderer/components/paneFocus'

describe('pane focus helpers', () => {
  it('parses valid pane values', () => {
    expect(getPaneFromValue('left')).toBe('left')
    expect(getPaneFromValue('right')).toBe('right')
    expect(getPaneFromValue('')).toBeNull()
    expect(getPaneFromValue(undefined)).toBeNull()
  })

  it('prefers the active pane for menu actions', () => {
    expect(resolvePaneForMenuAction(true, 'right', 'left')).toBe('right')
    expect(resolvePaneForMenuAction(true, 'left', 'right')).toBe('left')
  })

  it('falls back to the remembered pane when split is open', () => {
    expect(resolvePaneForMenuAction(true, null, 'right')).toBe('right')
  })

  it('defaults to the left pane without an active or remembered pane', () => {
    expect(resolvePaneForMenuAction(true, null, null)).toBe('left')
    expect(resolvePaneForMenuAction(false, null, 'right')).toBe('left')
  })
})

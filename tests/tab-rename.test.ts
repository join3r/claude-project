import { describe, expect, it } from 'vitest'
import { isRenamableTab, type Tab } from '../src/shared/types'

function makeTab(partial: Partial<Tab> & Pick<Tab, 'type'>): Tab {
  return { id: 't', title: 'x', ...partial }
}

describe('isRenamableTab', () => {
  it('returns true for terminal, browser, and AI tabs', () => {
    expect(isRenamableTab(makeTab({ type: 'terminal' }))).toBe(true)
    expect(isRenamableTab(makeTab({ type: 'browser' }))).toBe(true)
    expect(isRenamableTab(makeTab({ type: 'claude' }))).toBe(true)
    expect(isRenamableTab(makeTab({ type: 'codex' }))).toBe(true)
    expect(isRenamableTab(makeTab({ type: 'pi' }))).toBe(true)
  })

  it('returns false for derived-title and home tabs', () => {
    expect(isRenamableTab(makeTab({ type: 'note' }))).toBe(false)
    expect(isRenamableTab(makeTab({ type: 'diff' }))).toBe(false)
    expect(isRenamableTab(makeTab({ type: 'editor' }))).toBe(false)
    expect(isRenamableTab(makeTab({ type: 'home' }))).toBe(false)
    expect(isRenamableTab(makeTab({ type: 'terminal', system: 'home' }))).toBe(false)
  })
})

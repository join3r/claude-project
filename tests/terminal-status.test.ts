import { describe, it, expect } from 'vitest'
import {
  terminalStatusFromOutput,
  PINNABLE_TAB_TYPES,
  isPinnable
} from '../src/renderer/components/terminalStatus'
import type { Tab } from '../src/shared/types'

function tab(type: Tab['type'], extra: Partial<Tab> = {}): Tab {
  return { id: 't', type, title: 'x', ...extra }
}

describe('terminalStatusFromOutput', () => {
  it('returns attention on error keyword', () => {
    expect(terminalStatusFromOutput('Error: failed to fetch', null)).toBe('attention')
    expect(terminalStatusFromOutput('vitest FAILED', null)).toBe('attention')
    expect(terminalStatusFromOutput('1 FAIL', null)).toBe('attention')
  })
  it('returns null on ready keyword', () => {
    expect(terminalStatusFromOutput('vite ready in 412ms', 'working')).toBeNull()
    expect(terminalStatusFromOutput('listening on :3000', 'working')).toBeNull()
    expect(terminalStatusFromOutput('compiled successfully', 'attention')).toBeNull()
  })
  it('keeps attention sticky through neutral output', () => {
    expect(terminalStatusFromOutput('some unrelated line', 'attention')).toBe('attention')
  })
  it('returns working for neutral output when not in attention', () => {
    expect(terminalStatusFromOutput('GET /api/x 200', null)).toBe('working')
    expect(terminalStatusFromOutput('GET /api/x 200', 'working')).toBe('working')
    expect(terminalStatusFromOutput('GET /api/x 200', 'exited')).toBe('working')
  })
  it('matches case-insensitively', () => {
    expect(terminalStatusFromOutput('ERROR boom', null)).toBe('attention')
    expect(terminalStatusFromOutput('READY in 50ms', null)).toBeNull()
  })
})

describe('PINNABLE_TAB_TYPES / isPinnable', () => {
  it('includes terminal and AI tab types', () => {
    expect(PINNABLE_TAB_TYPES.has('terminal')).toBe(true)
    expect(PINNABLE_TAB_TYPES.has('claude')).toBe(true)
    expect(PINNABLE_TAB_TYPES.has('codex')).toBe(true)
    expect(PINNABLE_TAB_TYPES.has('opencode')).toBe(true)
  })
  it('excludes non-PTY tab types', () => {
    expect(PINNABLE_TAB_TYPES.has('browser')).toBe(false)
    expect(PINNABLE_TAB_TYPES.has('editor')).toBe(false)
    expect(PINNABLE_TAB_TYPES.has('diff')).toBe(false)
    expect(PINNABLE_TAB_TYPES.has('note')).toBe(false)
  })
  it('isPinnable reads from a Tab', () => {
    expect(isPinnable(tab('terminal'))).toBe(true)
    expect(isPinnable(tab('browser'))).toBe(false)
  })
})

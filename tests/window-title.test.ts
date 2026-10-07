import { describe, expect, it } from 'vitest'
import { buildWindowTitle } from '../src/renderer/hooks/useAppState'

describe('buildWindowTitle', () => {
  it('reads project › stream — task', () => {
    expect(buildWindowTitle('claude-project', 'Window name', { name: '0.6.0' })).toBe('claude-project › 0.6.0 — Window name')
  })

  it('leaves the stream out on main', () => {
    expect(buildWindowTitle('claude-project', 'Window name', { name: 'main', isMain: true })).toBe('claude-project — Window name')
  })

  it('leaves the stream out when it is unknown', () => {
    expect(buildWindowTitle('claude-project', 'Window name')).toBe('claude-project — Window name')
  })

  it('falls back to the project name when no task is selected', () => {
    expect(buildWindowTitle('claude-project', null, { name: '0.6.0' })).toBe('claude-project')
  })

  it('falls back to the app name when nothing is selected', () => {
    expect(buildWindowTitle(null, null)).toBe('DevTool')
  })
})

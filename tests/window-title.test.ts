import { describe, expect, it } from 'vitest'
import { buildWindowTitle } from '../src/renderer/hooks/useAppState'

describe('buildWindowTitle', () => {
  it('formats the selected project and task as project slash task', () => {
    expect(buildWindowTitle('claude-project', 'Window name')).toBe('claude-project / Window name')
  })

  it('falls back to the project name when no task is selected', () => {
    expect(buildWindowTitle('claude-project', null)).toBe('claude-project')
  })

  it('falls back to the app name when nothing is selected', () => {
    expect(buildWindowTitle(null, null)).toBe('DevTool')
  })
})

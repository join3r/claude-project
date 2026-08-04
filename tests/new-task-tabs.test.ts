import { describe, it, expect } from 'vitest'
import { createTab, isAutoOpenAvailable, newTaskInitialTabs } from '../src/renderer/components/newTaskTabs'

const allEnabled = { enableClaude: true, enableCodex: true, enablePi: true }
const allDisabled = { enableClaude: false, enableCodex: false, enablePi: false }

describe('createTab', () => {
  it('titles a tab after its tool', () => {
    expect(createTab('claude').title).toBe('Claude Code')
    expect(createTab('codex').title).toBe('Codex')
    expect(createTab('pi').title).toBe('Pi')
    expect(createTab('terminal').title).toBe('Terminal')
    expect(createTab('browser').title).toBe('Browser')
  })

  it('gives pi — and only pi — a pre-generated session id to resume into', () => {
    expect(createTab('pi').sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(createTab('claude').sessionId).toBeUndefined()
    expect(createTab('terminal').sessionId).toBeUndefined()
  })

  it('mints a fresh id per tab', () => {
    expect(createTab('terminal').id).not.toBe(createTab('terminal').id)
  })

  it('names a file tab after the file, and marks a diff as one', () => {
    expect(createTab('editor', { filePath: '/a/b/index.ts' }).title).toBe('index.ts')
    expect(createTab('diff', { filePath: '/a/b/index.ts' }).title).toBe('index.ts (diff)')
  })

  it('prefers the note name, falling back to a generic title', () => {
    expect(createTab('note', { noteId: 'n1', noteName: 'Scratch' }).title).toBe('Scratch')
    expect(createTab('note', { noteId: 'n1' }).title).toBe('Note')
  })

  it('omits optional fields that were not asked for', () => {
    const tab = createTab('browser')
    expect('url' in tab).toBe(false)
    expect('filePath' in tab).toBe(false)
    expect('noteId' in tab).toBe(false)
  })

  it('carries a start url through when given one', () => {
    expect(createTab('browser', { url: 'https://example.com' }).url).toBe('https://example.com')
  })
})

describe('newTaskInitialTabs', () => {
  it('opens nothing by default', () => {
    expect(newTaskInitialTabs('none', allEnabled)).toEqual([])
  })

  it('opens exactly one tab of the configured type', () => {
    const tabs = newTaskInitialTabs('claude', allEnabled)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].type).toBe('claude')
    expect(newTaskInitialTabs('terminal', allDisabled)[0].type).toBe('terminal')
    expect(newTaskInitialTabs('browser', allDisabled)[0].type).toBe('browser')
  })

  it('opens nothing when the configured tool is disabled', () => {
    expect(newTaskInitialTabs('claude', allDisabled)).toEqual([])
    expect(newTaskInitialTabs('codex', allDisabled)).toEqual([])
    expect(newTaskInitialTabs('pi', allDisabled)).toEqual([])
  })

  it('gates each AI tool on its own flag', () => {
    const claudeOnly = { enableClaude: true, enableCodex: false, enablePi: false }
    expect(newTaskInitialTabs('claude', claudeOnly)).toHaveLength(1)
    expect(newTaskInitialTabs('codex', claudeOnly)).toHaveLength(0)
  })
})

describe('isAutoOpenAvailable', () => {
  it('only gates the AI options', () => {
    expect(isAutoOpenAvailable('none', allDisabled)).toBe(true)
    expect(isAutoOpenAvailable('terminal', allDisabled)).toBe(true)
    expect(isAutoOpenAvailable('browser', allDisabled)).toBe(true)
    expect(isAutoOpenAvailable('pi', allDisabled)).toBe(false)
    expect(isAutoOpenAvailable('pi', allEnabled)).toBe(true)
  })
})

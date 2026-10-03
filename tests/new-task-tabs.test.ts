import { describe, it, expect } from 'vitest'
import { createTab } from '../src/renderer/components/newTaskTabs'

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
    expect(createTab('notebook', { filePath: '/a/b/demo.ipynb' }).title).toBe('demo.ipynb')
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

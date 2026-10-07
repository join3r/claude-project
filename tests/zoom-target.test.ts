import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/shared/types'
import { EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN } from '../src/renderer/components/monacoOptions'
import { nextEditorFontSize, zoomTargetForTabType } from '../src/renderer/components/zoom'

describe('zoomTargetForTabType', () => {
  it('zooms the browser when a browser tab is focused', () => {
    expect(zoomTargetForTabType('browser')).toBe('browser')
  })

  it('zooms editor font for notebook, editor, note, and diff', () => {
    expect(zoomTargetForTabType('notebook')).toBe('editor')
    expect(zoomTargetForTabType('editor')).toBe('editor')
    expect(zoomTargetForTabType('note')).toBe('editor')
    expect(zoomTargetForTabType('diff')).toBe('editor')
  })

  it('keeps terminal zoom for shells, agents, and unknown tabs', () => {
    expect(zoomTargetForTabType('terminal')).toBe('terminal')
    expect(zoomTargetForTabType('claude')).toBe('terminal')
    expect(zoomTargetForTabType('codex')).toBe('terminal')
    expect(zoomTargetForTabType('pi')).toBe('terminal')
    expect(zoomTargetForTabType(undefined)).toBe('terminal')
    expect(zoomTargetForTabType(null)).toBe('terminal')
  })
})

describe('nextEditorFontSize', () => {
  it('steps by 1px and clamps to the editor min/max', () => {
    expect(nextEditorFontSize(14, 'in')).toBe(15)
    expect(nextEditorFontSize(14, 'out')).toBe(13)
    expect(nextEditorFontSize(EDITOR_FONT_SIZE_MIN, 'out')).toBe(EDITOR_FONT_SIZE_MIN)
    expect(nextEditorFontSize(EDITOR_FONT_SIZE_MAX, 'in')).toBe(EDITOR_FONT_SIZE_MAX)
  })

  it('resets to the default editor font size', () => {
    expect(nextEditorFontSize(22, 'reset')).toBe(DEFAULT_CONFIG.editorFontSize)
  })
})

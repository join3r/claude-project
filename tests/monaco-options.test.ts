import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/shared/types'
import {
  buildMonacoDiffOptions,
  buildMonacoEditorOptions,
  getLanguageFromPath
} from '../src/renderer/components/monacoOptions'

describe('monacoOptions', () => {
  it('maps file extensions to Monaco languages', () => {
    expect(getLanguageFromPath('src/App.tsx')).toBe('typescript')
    expect(getLanguageFromPath('scripts/build.sh')).toBe('shell')
    expect(getLanguageFromPath('README.unknown')).toBe('plaintext')
  })

  it('builds editor options from config', () => {
    const options = buildMonacoEditorOptions({
      ...DEFAULT_CONFIG,
      editorFontFamily: 'JetBrains Mono',
      editorFontSize: 16,
      editorLineNumbers: 'relative',
      editorMinimap: true,
      editorRenderWhitespace: 'all',
      editorTabSize: 2,
      editorWordWrap: 'bounded'
    })

    expect(options).toMatchObject({
      automaticLayout: true,
      fontFamily: 'JetBrains Mono',
      fontSize: 16,
      lineNumbers: 'relative',
      renderWhitespace: 'all',
      tabSize: 2,
      wordWrap: 'bounded'
    })
    expect(options.minimap).toEqual({ enabled: true })
  })

  it('builds diff options from config', () => {
    const options = buildMonacoDiffOptions({
      ...DEFAULT_CONFIG,
      editorFontFamily: 'Iosevka',
      diffIgnoreTrimWhitespace: false,
      diffRenderSideBySide: false
    })

    expect(options).toMatchObject({
      fontFamily: 'Iosevka',
      ignoreTrimWhitespace: false,
      readOnly: true,
      renderSideBySide: false
    })
  })
})

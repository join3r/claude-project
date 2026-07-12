import type { Monaco } from '@monaco-editor/react'

// Warm Monaco themes matching the app palette (styles.css @theme). Syntax token
// colors stay stock vs/vs-dark; only editor chrome is retuned so the editor
// doesn't sit as a cool gray slab inside the warm paper/ink chrome.
export const MONACO_THEME_DARK = 'devtool-dark'
export const MONACO_THEME_LIGHT = 'devtool-light'

let defined = false

export function defineMonacoThemes(monaco: Monaco): void {
  if (defined) return
  defined = true

  monaco.editor.defineTheme(MONACO_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1d1b18',
      'editor.foreground': '#f0ece4',
      'editorLineNumber.foreground': '#7c766c',
      'editorLineNumber.activeForeground': '#9b948a',
      'editor.selectionBackground': '#c7925744',
      'editor.inactiveSelectionBackground': '#c7925726',
      'editor.lineHighlightBackground': '#211f1b',
      'editorGutter.background': '#1d1b18',
      'editorWidget.background': '#2a2722',
      'editorWidget.border': '#35312b',
      'editorCursor.foreground': '#c79257',
      'scrollbarSlider.background': '#f0ece42e',
      'scrollbarSlider.hoverBackground': '#f0ece440',
      'scrollbarSlider.activeBackground': '#f0ece45c',
      'minimap.background': '#1d1b18'
    }
  })

  monaco.editor.defineTheme(MONACO_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#faf8f3',
      'editor.foreground': '#23211d',
      'editorLineNumber.foreground': '#a39c90',
      'editorLineNumber.activeForeground': '#7c766c',
      'editor.selectionBackground': '#9a623029',
      'editor.inactiveSelectionBackground': '#9a623014',
      'editor.lineHighlightBackground': '#f6f4ef',
      'editorGutter.background': '#faf8f3',
      'editorWidget.background': '#fffdf9',
      'editorWidget.border': '#e0dccf',
      'editorCursor.foreground': '#9a6230',
      'scrollbarSlider.background': '#23211d2e',
      'scrollbarSlider.hoverBackground': '#23211d40',
      'scrollbarSlider.activeBackground': '#23211d5c',
      'minimap.background': '#faf8f3'
    }
  })
}

export function monacoThemeFor(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? MONACO_THEME_DARK : MONACO_THEME_LIGHT
}

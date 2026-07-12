import type { ITheme } from '@xterm/xterm'
import type { TerminalColorScheme } from '../../shared/types'

export type { TerminalColorScheme }

export interface TerminalSchemeOption {
  value: TerminalColorScheme
  label: string
  description: string
}

export const TERMINAL_SCHEME_OPTIONS: TerminalSchemeOption[] = [
  { value: 'auto', label: 'Auto (Sienna)', description: 'Matches the app theme; warm sienna palette.' },
  { value: 'solarized-dark', label: 'Solarized Dark', description: 'Ethan Schoonover’s Solarized Dark.' },
  { value: 'solarized-light', label: 'Solarized Light', description: 'Ethan Schoonover’s Solarized Light.' },
  { value: 'one-dark', label: 'One Dark', description: 'Atom’s One Dark.' },
  { value: 'dracula', label: 'Dracula', description: 'Dracula dark.' },
  { value: 'monokai', label: 'Monokai', description: 'Monokai-inspired dark.' },
  { value: 'classic', label: 'Classic', description: 'xterm defaults; bright primary colors.' }
]

interface AnsiPalette {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

const siennaDarkAnsi: AnsiPalette = {
  black: '#2a2722',
  red: '#d97b6c',
  green: '#8aa671',
  yellow: '#c79257',
  blue: '#7ba0c0',
  magenta: '#b57e9c',
  cyan: '#8aaba4',
  white: '#d8d2c6',
  brightBlack: '#5c564d',
  brightRed: '#e8987f',
  brightGreen: '#a8c592',
  brightYellow: '#ddb684',
  brightBlue: '#9bb9d4',
  brightMagenta: '#d09bba',
  brightCyan: '#a3c5be',
  brightWhite: '#f0ece4'
}

const siennaLightAnsi: AnsiPalette = {
  black: '#2a1a0c',
  red: '#a04030',
  green: '#5e7d3c',
  yellow: '#9a6230',
  blue: '#3d6a8a',
  magenta: '#874a6e',
  cyan: '#487872',
  white: '#7c766c',
  brightBlack: '#5b5447',
  brightRed: '#b54f2c',
  brightGreen: '#6e8d4c',
  brightYellow: '#b87a2a',
  brightBlue: '#4d7a9a',
  brightMagenta: '#97607e',
  brightCyan: '#588882',
  brightWhite: '#23211d'
}

interface FixedScheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent?: string
  selectionBackground: string
  selectionInactiveBackground?: string
  ansi: AnsiPalette
  /** affects scrollbar slider — 'light' = darker slider on light bg */
  appearance: 'dark' | 'light'
}

const solarizedAnsi: AnsiPalette = {
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#657b83',
  brightYellow: '#839496',
  brightBlue: '#93a1a1',
  brightMagenta: '#6c71c4',
  brightCyan: '#94a1a1',
  brightWhite: '#fdf6e3'
}

const solarizedDark: FixedScheme = {
  background: '#002b36',
  foreground: '#93a1a1',
  cursor: '#93a1a1',
  cursorAccent: '#002b36',
  selectionBackground: '#073642',
  selectionInactiveBackground: '#073642',
  ansi: solarizedAnsi,
  appearance: 'dark'
}

const solarizedLight: FixedScheme = {
  background: '#fdf6e3',
  foreground: '#586e75',
  cursor: '#586e75',
  cursorAccent: '#fdf6e3',
  selectionBackground: '#eee8d5',
  selectionInactiveBackground: '#eee8d5',
  ansi: solarizedAnsi,
  appearance: 'light'
}

const oneDark: FixedScheme = {
  background: '#282c34',
  foreground: '#abb2bf',
  cursor: '#528bff',
  cursorAccent: '#282c34',
  selectionBackground: '#3e4451',
  selectionInactiveBackground: '#3e4451',
  ansi: {
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff'
  },
  appearance: 'dark'
}

const dracula: FixedScheme = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: '#44475a',
  selectionInactiveBackground: '#44475a',
  ansi: {
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff'
  },
  appearance: 'dark'
}

const monokai: FixedScheme = {
  background: '#272822',
  foreground: '#f8f8f2',
  cursor: '#f8f8f0',
  cursorAccent: '#272822',
  selectionBackground: '#49483e',
  selectionInactiveBackground: '#49483e',
  ansi: {
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5'
  },
  appearance: 'dark'
}

const FIXED_SCHEMES: Record<Exclude<TerminalColorScheme, 'auto' | 'classic'>, FixedScheme> = {
  'solarized-dark': solarizedDark,
  'solarized-light': solarizedLight,
  'one-dark': oneDark,
  'dracula': dracula,
  'monokai': monokai
}

function readCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function scrollbarColors(appearance: 'dark' | 'light') {
  const isLight = appearance === 'light'
  return {
    scrollbarSliderBackground: isLight ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.15)',
    scrollbarSliderHoverBackground: isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.25)',
    scrollbarSliderActiveBackground: isLight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.35)'
  }
}

/**
 * Build an xterm theme for a given scheme + light/dark mode.
 *
 * - `auto`: pulls bg/fg/cursor/selection from app CSS vars (so the terminal blends
 *   with app chrome) and applies a hand-picked sienna-leaning ANSI palette.
 * - `classic`: returns only chrome colors (no ANSI) so xterm's defaults remain.
 * - Named schemes (Solarized, One Dark, etc.): canonical palette regardless of
 *   app theme — the user explicitly chose that look.
 */
export function buildXtermTheme(theme: 'dark' | 'light', scheme: TerminalColorScheme): ITheme {
  if (scheme === 'classic') {
    return {
      background: readCssVar('--color-bg'),
      foreground: readCssVar('--color-text'),
      cursor: readCssVar('--color-accent-400'),
      selectionBackground: readCssVar('--color-accent-600') + '60',
      selectionInactiveBackground: readCssVar('--color-accent-700') + '40',
      ...scrollbarColors(theme)
    }
  }

  if (scheme === 'auto') {
    const ansi = theme === 'light' ? siennaLightAnsi : siennaDarkAnsi
    return {
      background: readCssVar('--color-bg'),
      foreground: readCssVar('--color-text'),
      cursor: readCssVar('--color-accent-400'),
      cursorAccent: readCssVar('--color-bg'),
      selectionBackground: readCssVar('--color-accent-600') + '60',
      selectionInactiveBackground: readCssVar('--color-accent-700') + '40',
      ...scrollbarColors(theme),
      ...ansi
    }
  }

  const fixed = FIXED_SCHEMES[scheme]
  return {
    background: fixed.background,
    foreground: fixed.foreground,
    cursor: fixed.cursor,
    cursorAccent: fixed.cursorAccent ?? fixed.background,
    selectionBackground: fixed.selectionBackground,
    selectionInactiveBackground: fixed.selectionInactiveBackground ?? fixed.selectionBackground,
    ...scrollbarColors(fixed.appearance),
    ...fixed.ansi
  }
}

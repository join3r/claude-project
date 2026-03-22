import type { editor } from 'monaco-editor'
import type { AppConfig } from '../../shared/types'

export const EDITOR_FONT_SIZE_MIN = 8
export const EDITOR_FONT_SIZE_MAX = 32
export const EDITOR_TAB_SIZE_MIN = 1
export const EDITOR_TAB_SIZE_MAX = 8

const DEFAULT_EDITOR_FONT_SIZE = 14
const DEFAULT_EDITOR_TAB_SIZE = 4

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  toml: 'toml',
  xml: 'xml',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  r: 'r',
  lua: 'lua',
  dart: 'dart',
  graphql: 'graphql',
  scss: 'scss',
  less: 'less'
}

function clamp(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGE_MAP[ext] ?? 'plaintext'
}

export function buildMonacoEditorOptions(config: AppConfig): editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    fontFamily: config.editorFontFamily,
    fontSize: clamp(config.editorFontSize, DEFAULT_EDITOR_FONT_SIZE, EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX),
    lineNumbers: config.editorLineNumbers,
    minimap: { enabled: config.editorMinimap },
    renderWhitespace: config.editorRenderWhitespace,
    tabSize: clamp(config.editorTabSize, DEFAULT_EDITOR_TAB_SIZE, EDITOR_TAB_SIZE_MIN, EDITOR_TAB_SIZE_MAX),
    wordWrap: config.editorWordWrap
  }
}

export function buildMonacoDiffOptions(config: AppConfig): editor.IStandaloneDiffEditorConstructionOptions {
  return {
    ...buildMonacoEditorOptions(config),
    ignoreTrimWhitespace: config.diffIgnoreTrimWhitespace,
    readOnly: true,
    renderSideBySide: config.diffRenderSideBySide
  }
}

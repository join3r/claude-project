import React, { useState, useEffect, useRef, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { DEFAULT_CONFIG } from '../../shared/types'
import { useApp } from '../context/AppContext'
import { FILE_BROWSER_REFRESH_MS } from '../hooks/fileBrowserRefresh'
import { buildMonacoEditorOptions, getLanguageFromPath } from './monacoOptions'
import MarkdownPreview from './MarkdownPreview'

interface Props {
  tabId: string
  visible: boolean
  filePath: string
  projectDir: string
  projectId: string
  taskId: string
  pane: 'left' | 'right'
  effectiveTheme: 'dark' | 'light'
}

export default function EditorTab({ tabId, visible, filePath, projectDir, projectId, taskId, pane, effectiveTheme }: Props): React.ReactElement {
  const { config } = useApp()
  const [content, setContent] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const savedContentRef = useRef<string>('')
  const currentContentRef = useRef<string>('')
  const dirtyRef = useRef(false)
  const requestIdRef = useRef(0)
  const monacoConfig = config ?? DEFAULT_CONFIG

  const isMarkdown = getLanguageFromPath(filePath) === 'markdown'
  const [viewMode, setViewMode] = useState<'source' | 'preview'>(isMarkdown ? 'preview' : 'source')
  const [previewContent, setPreviewContent] = useState('')

  const handleToggleView = useCallback(() => {
    setViewMode(prev => {
      const next = prev === 'source' ? 'preview' : 'source'
      if (next === 'preview') {
        setPreviewContent(currentContentRef.current)
      }
      return next
    })
  }, [])

  // Keep preview content in sync when file refreshes from disk
  useEffect(() => {
    if (viewMode === 'preview' && content !== null) {
      setPreviewContent(dirtyRef.current ? currentContentRef.current : content)
    }
  }, [viewMode, content])

  const refreshContent = useCallback((force = false) => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId

    window.api.fbReadFile(projectDir, filePath).then(text => {
      if (requestId !== requestIdRef.current) return
      setError(null)

      if (!force && dirtyRef.current) return
      if (!force && text === savedContentRef.current) return

      savedContentRef.current = text
      currentContentRef.current = text
      dirtyRef.current = false
      setDirty(false)
      setContent(text)

      if (editorRef.current && editorRef.current.getValue() !== text) {
        editorRef.current.setValue(text)
      }
    }).catch(() => {
      if (requestId !== requestIdRef.current) return
      if (!force && dirtyRef.current) return

      setError('Unable to read file.')
      setContent(null)
      savedContentRef.current = ''
      currentContentRef.current = ''
      dirtyRef.current = false
      setDirty(false)
    })
  }, [filePath, projectDir])

  useEffect(() => {
    setContent(null)
    setError(null)
    savedContentRef.current = ''
    currentContentRef.current = ''
    dirtyRef.current = false
    setDirty(false)
    refreshContent(true)
    return () => {
      requestIdRef.current += 1
    }
  }, [refreshContent])

  useEffect(() => {
    if (!visible) return

    refreshContent()

    const intervalId = window.setInterval(() => {
      refreshContent()
    }, FILE_BROWSER_REFRESH_MS)

    const handleFocus = () => refreshContent()
    const handleReload = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (detail?.tabId && detail.tabId !== tabId) return
      refreshContent(true)
    }

    window.addEventListener('focus', handleFocus)
    window.addEventListener('reload-file-tab', handleReload)

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('reload-file-tab', handleReload)
    }
  }, [refreshContent, tabId, visible])

  useEffect(() => {
    if (!editorRef.current) return
    editorRef.current.updateOptions(buildMonacoEditorOptions(monacoConfig))
    editorRef.current.layout()
  }, [config, monacoConfig])

  const handleEditorDidMount = (ed: editor.IStandaloneCodeEditor) => {
    editorRef.current = ed
    // Bind Cmd+S / Ctrl+S to save
    ed.addCommand(
      // Monaco KeyMod.CtrlCmd | Monaco KeyCode.KeyS
      2048 | 49, // CtrlCmd + S
      () => {
        const value = ed.getValue()
        window.api.fbWriteFile(projectDir, filePath, value).then(() => {
          savedContentRef.current = value
          currentContentRef.current = value
          dirtyRef.current = false
          setDirty(false)
          setContent(value)
          setError(null)
          window.dispatchEvent(new CustomEvent('file-saved', { detail: { filePath, projectDir } }))
        })
      }
    )
    // Bind Cmd+Shift+V / Ctrl+Shift+V to toggle markdown preview
    if (isMarkdown) {
      ed.addCommand(
        2048 | 1024 | 52, // CtrlCmd + Shift + V
        () => handleToggleView()
      )
    }
  }

  const handleChange = (value: string | undefined) => {
    const nextValue = value ?? ''
    currentContentRef.current = nextValue
    dirtyRef.current = nextValue !== savedContentRef.current
    setDirty(dirtyRef.current)
  }

  if (!visible) return <div style={{ display: 'none' }} />
  if (error !== null) return <div className="tab-content-placeholder">{error}</div>
  if (content === null) return <div className="tab-content-placeholder">Loading...</div>

  return (
    <div style={{ position: 'absolute', inset: 0, display: visible ? 'block' : 'none' }}>
      <div style={{ position: 'absolute', inset: 0, display: (!isMarkdown || viewMode === 'source') ? 'block' : 'none' }}>
        <Editor
          defaultValue={content}
          language={getLanguageFromPath(filePath)}
          theme={effectiveTheme === 'dark' ? 'vs-dark' : 'vs'}
          options={buildMonacoEditorOptions(monacoConfig)}
          onMount={handleEditorDidMount}
          onChange={handleChange}
        />
      </div>
      {isMarkdown && viewMode === 'preview' && (
        <MarkdownPreview content={previewContent} effectiveTheme={effectiveTheme} />
      )}
      {isMarkdown && (
        <button
          className="md-view-toggle"
          onClick={handleToggleView}
          title={viewMode === 'source' ? 'Show preview (⌘⇧V)' : 'Show source (⌘⇧V)'}
        >
          {viewMode === 'source' ? 'Preview' : 'Source'}
        </button>
      )}
      {dirty && <div style={{ position: 'absolute', top: 4, right: 12, width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', zIndex: 5 }} />}
    </div>
  )
}

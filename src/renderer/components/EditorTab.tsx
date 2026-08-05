import React, { useState, useEffect, useRef, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { DEFAULT_CONFIG } from '../../shared/types'
import { useApp } from '../context/AppContext'
import { useDirtyBufferStore } from '../context/DirtyBufferContext'
import { FILE_BROWSER_REFRESH_MS } from '../hooks/fileBrowserRefresh'
import { buildMonacoEditorOptions, getLanguageFromPath } from './monacoOptions'
import { defineMonacoThemes, monacoThemeFor } from './monacoTheme'
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
  const dirtyBuffers = useDirtyBufferStore()
  const [content, setContent] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Monaco is mounted lazily on first reveal, but never unmounted afterwards:
  // the wrapper disposes the model on unmount, which would throw away an
  // unsaved buffer (and its undo history) whenever another tab is activated.
  const [everVisible, setEverVisible] = useState(visible)
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
    setSaveError(null)
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

  useEffect(() => {
    if (!visible) return
    setEverVisible(true)
    // The editor stayed mounted but hidden, so it measured itself against a
    // zero-sized container. Re-measure now that the container has a box again.
    editorRef.current?.layout()
  }, [visible])

  // Reports the failure in the tab *and* rejects, so the close gate can keep a
  // tab whose buffer never reached disk. Every in-tab caller goes through
  // `saveContent`, which swallows the rejection after the error is on screen.
  const writeBuffer = useCallback((): Promise<void> => {
    const ed = editorRef.current
    if (!ed) return Promise.resolve()
    const value = ed.getValue()
    setSaveError(null)
    return window.api.fbWriteFile(projectDir, filePath, value).then(() => {
      savedContentRef.current = value
      // The buffer may have moved on while the write was in flight; recompute
      // dirtiness against what the editor actually holds now.
      dirtyRef.current = currentContentRef.current !== value
      setDirty(dirtyRef.current)
      setContent(value)
      setError(null)
      setSaveError(null)
      window.dispatchEvent(new CustomEvent('file-saved', { detail: { filePath, projectDir } }))
    }, (err: unknown) => {
      // The buffer and its dirty state are deliberately left untouched so the
      // user can retry or copy their work out.
      const message = err instanceof Error ? err.message : String(err)
      setSaveError(message ? `Save failed: ${message}` : 'Save failed.')
      throw err
    })
  }, [filePath, projectDir])

  const saveContent = useCallback(() => {
    // A failed write must stay inside this tab: an unhandled rejection is
    // turned into a full-window crash screen by src/renderer/main.tsx.
    void writeBuffer().catch(() => {})
  }, [writeBuffer])

  // The Monaco command is registered once on mount, so route it through a ref
  // to keep it from saving to a stale path after the tab is pointed elsewhere.
  const saveContentRef = useRef(saveContent)
  useEffect(() => {
    saveContentRef.current = saveContent
  }, [saveContent])

  const writeBufferRef = useRef(writeBuffer)
  useEffect(() => {
    writeBufferRef.current = writeBuffer
  }, [writeBuffer])

  // Publish the buffer so removal paths outside this tab (⌘W, the tab-bar close
  // button, task and project deletion) can find out it is unsaved before they
  // tear the editor down. The registration is re-published on every dirty
  // transition and released with its own token, so the hide/show remount can
  // neither leave a stale entry behind nor drop the live one.
  useEffect(() => {
    const token = dirtyBuffers.registerBuffer(tabId, {
      filePath,
      isDirty: dirty,
      save: () => writeBufferRef.current()
    })
    return () => dirtyBuffers.unregisterBuffer(tabId, token)
  }, [dirtyBuffers, tabId, filePath, dirty])

  const handleEditorDidMount = (ed: editor.IStandaloneCodeEditor) => {
    editorRef.current = ed
    // Bind Cmd+S / Ctrl+S to save
    ed.addCommand(
      // Monaco KeyMod.CtrlCmd | Monaco KeyCode.KeyS
      2048 | 49, // CtrlCmd + S
      () => saveContentRef.current()
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

  // Once mounted the editor is only ever hidden with CSS — see `everVisible`.
  if (!visible && !everVisible) return <div style={{ display: 'none' }} />

  return (
    <div style={{ position: 'absolute', inset: 0, display: visible ? 'block' : 'none' }}>
      {content === null ? (
        <div className="tab-content-placeholder">{error ?? 'Loading...'}</div>
      ) : (
        <>
          <div style={{ position: 'absolute', inset: 0, display: (!isMarkdown || viewMode === 'source') ? 'block' : 'none' }}>
            <Editor
              defaultValue={content}
              language={getLanguageFromPath(filePath)}
              theme={monacoThemeFor(effectiveTheme)}
              beforeMount={defineMonacoThemes}
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
              className="absolute top-1.5 right-7 z-(--z-sticky) bg-surface border border-border text-accent cursor-pointer px-2 py-0.5 rounded-md text-sm leading-snug hover:underline"
              onClick={handleToggleView}
              title={viewMode === 'source' ? 'Show preview (⌘⇧V)' : 'Show source (⌘⇧V)'}
            >
              {viewMode === 'source' ? 'Preview' : 'Source'}
            </button>
          )}
        </>
      )}
      {saveError !== null && (
        <div
          role="alert"
          className="absolute bottom-2 left-2 right-2 z-(--z-sticky) flex items-center gap-2 bg-surface border border-border rounded-md px-2 py-1 text-sm leading-snug"
          style={{ color: 'var(--color-danger)' }}
        >
          <span className="flex-1 truncate" title={saveError}>{saveError}</span>
          <button
            className="text-accent cursor-pointer hover:underline"
            onClick={saveContent}
          >
            Retry
          </button>
          <button
            className="text-accent cursor-pointer hover:underline"
            onClick={() => setSaveError(null)}
            title="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}
      {dirty && <div title="Unsaved changes" style={{ position: 'absolute', top: 4, right: 12, width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)', zIndex: 5 }} />}
    </div>
  )
}

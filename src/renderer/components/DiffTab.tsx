import React, { useEffect, useRef, useState } from 'react'
import { loader, type Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { DEFAULT_CONFIG } from '../../shared/types'
import { useApp } from '../context/AppContext'
import { FILE_BROWSER_REFRESH_MS } from '../hooks/fileBrowserRefresh'
import { buildMonacoDiffOptions, getLanguageFromPath } from './monacoOptions'

interface Props {
  tabId: string
  visible: boolean
  filePath: string
  projectDir: string
  effectiveTheme: 'dark' | 'light'
}

export default function DiffTab({ tabId, visible, filePath, projectDir, effectiveTheme }: Props): React.ReactElement {
  const { config } = useApp()
  const [original, setOriginal] = useState<string | null>(null)
  const [modified, setModified] = useState<string | null>(null)
  const [editorReady, setEditorReady] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const modelsRef = useRef<{
    original: editor.ITextModel | null
    modified: editor.ITextModel | null
  }>({
    original: null,
    modified: null
  })
  const requestIdRef = useRef(0)
  const monacoConfig = config ?? DEFAULT_CONFIG

  const clearEditorModel = () => {
    try {
      editorRef.current?.setModel(null)
    } catch {
      // Monaco may already be in teardown.
    }
  }

  const disposeModels = () => {
    const { original: originalModel, modified: modifiedModel } = modelsRef.current
    modelsRef.current = { original: null, modified: null }
    originalModel?.dispose()
    modifiedModel?.dispose()
  }

  useEffect(() => {
    setOriginal(null)
    setModified(null)
    requestIdRef.current += 1
  }, [filePath, projectDir])

  useEffect(() => {
    if (!visible) return

    const refreshDiff = () => {
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId

      Promise.all([
        window.api.fbGitDiff(projectDir, filePath),
        window.api.fbReadFile(projectDir, filePath).catch(() => '')
      ]).then(([orig, mod]) => {
        if (requestId !== requestIdRef.current) return
        setOriginal(orig)
        setModified(mod)
      }).catch(() => {
        if (requestId !== requestIdRef.current) return
        setOriginal('')
        setModified('')
      })
    }

    refreshDiff()

    const intervalId = window.setInterval(() => {
      refreshDiff()
    }, FILE_BROWSER_REFRESH_MS)

    const handleFocus = () => refreshDiff()
    const handleFileSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ filePath?: string }>).detail
      if (detail?.filePath && detail.filePath !== filePath) return
      refreshDiff()
    }
    const handleReload = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (detail?.tabId && detail.tabId !== tabId) return
      refreshDiff()
    }

    window.addEventListener('focus', handleFocus)
    window.addEventListener('file-saved', handleFileSaved)
    window.addEventListener('reload-file-tab', handleReload)

    return () => {
      requestIdRef.current += 1
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('file-saved', handleFileSaved)
      window.removeEventListener('reload-file-tab', handleReload)
    }
  }, [filePath, projectDir, tabId, visible])

  useEffect(() => {
    let cancelled = false

    loader.init().then((monaco) => {
      if (cancelled || !containerRef.current || editorRef.current) return

      monacoRef.current = monaco
      editorRef.current = monaco.editor.createDiffEditor(containerRef.current, buildMonacoDiffOptions(monacoConfig))
      monaco.editor.setTheme(effectiveTheme === 'dark' ? 'vs-dark' : 'vs')
      setEditorReady(true)
    }).catch((error) => {
      if (!cancelled) {
        console.error('Failed to initialize Monaco diff editor', error)
      }
    })

    return () => {
      cancelled = true

      clearEditorModel()
      editorRef.current?.dispose()
      monacoRef.current = null
      editorRef.current = null
      disposeModels()
    }
  }, [])

  useEffect(() => {
    const monaco = monacoRef.current
    const diffEditor = editorRef.current
    if (!editorReady || !monaco || !diffEditor || original === null || modified === null) return

    clearEditorModel()
    disposeModels()
    const language = getLanguageFromPath(filePath)
    const originalModel = monaco.editor.createModel(
      original,
      language,
      monaco.Uri.from({ scheme: 'inmemory', path: `/diff/${tabId}/original/${filePath}` })
    )
    const modifiedModel = monaco.editor.createModel(
      modified,
      language,
      monaco.Uri.from({ scheme: 'inmemory', path: `/diff/${tabId}/modified/${filePath}` })
    )

    modelsRef.current = {
      original: originalModel,
      modified: modifiedModel
    }
    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel
    })
  }, [editorReady, filePath, modified, original, tabId])

  useEffect(() => {
    const monaco = monacoRef.current
    if (!editorReady || !monaco) return
    monaco.editor.setTheme(effectiveTheme === 'dark' ? 'vs-dark' : 'vs')
  }, [editorReady, effectiveTheme])

  useEffect(() => {
    if (!editorReady || !editorRef.current) return
    editorRef.current.updateOptions(buildMonacoDiffOptions(monacoConfig))
    editorRef.current.layout()
  }, [config, editorReady, monacoConfig])

  useEffect(() => {
    if (!visible) return
    editorRef.current?.layout()
  }, [visible])

  const isLoading = original === null || modified === null

  return (
    <div style={{ position: 'absolute', inset: 0, display: visible ? 'block' : 'none' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {isLoading && <div className="tab-content-placeholder">Loading...</div>}
    </div>
  )
}

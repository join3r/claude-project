import React, { useEffect, useRef, useState } from 'react'
import { loader, type Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'

interface Props {
  tabId: string
  visible: boolean
  filePath: string
  projectDir: string
  effectiveTheme: 'dark' | 'light'
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', css: 'css', html: 'html', py: 'python',
    rs: 'rust', go: 'go', java: 'java', yml: 'yaml', yaml: 'yaml',
    sh: 'shell', bash: 'shell', toml: 'toml', xml: 'xml', sql: 'sql',
    rb: 'ruby', php: 'php', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    swift: 'swift', kt: 'kotlin', scala: 'scala', r: 'r',
    lua: 'lua', dart: 'dart', graphql: 'graphql', scss: 'scss', less: 'less'
  }
  return map[ext] ?? 'plaintext'
}

export default function DiffTab({ tabId, visible, filePath, projectDir, effectiveTheme }: Props): React.ReactElement {
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
    let cancelled = false
    setOriginal(null)
    setModified(null)

    Promise.all([
      window.api.fbGitDiff(projectDir, filePath),
      window.api.fbReadFile(projectDir, filePath)
    ]).then(([orig, mod]) => {
      if (cancelled) return
      setOriginal(orig)
      setModified(mod)
    })

    return () => {
      cancelled = true
    }
  }, [projectDir, filePath])

  useEffect(() => {
    let cancelled = false

    loader.init().then((monaco) => {
      if (cancelled || !containerRef.current || editorRef.current) return

      monacoRef.current = monaco
      editorRef.current = monaco.editor.createDiffEditor(containerRef.current, {
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false }
      })
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

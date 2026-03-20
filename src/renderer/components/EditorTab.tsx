import React, { useState, useEffect, useRef } from 'react'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'

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

export default function EditorTab({ tabId, visible, filePath, projectDir, projectId, taskId, pane, effectiveTheme }: Props): React.ReactElement {
  const [content, setContent] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const savedContentRef = useRef<string>('')

  useEffect(() => {
    window.api.fbReadFile(projectDir, filePath).then(text => {
      setContent(text)
      savedContentRef.current = text
    })
  }, [projectDir, filePath])

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
          setDirty(false)
          window.dispatchEvent(new CustomEvent('file-saved', { detail: { filePath } }))
        })
      }
    )
  }

  const handleChange = (value: string | undefined) => {
    setDirty(value !== savedContentRef.current)
  }

  if (!visible) return <div style={{ display: 'none' }} />
  if (content === null) return <div className="tab-content-placeholder">Loading...</div>

  return (
    <div style={{ position: 'absolute', inset: 0, display: visible ? 'block' : 'none' }}>
      <Editor
        defaultValue={content}
        language={getLanguageFromPath(filePath)}
        theme={effectiveTheme === 'dark' ? 'vs-dark' : 'vs'}
        options={{
          automaticLayout: true,
          minimap: { enabled: false }
        }}
        onMount={handleEditorDidMount}
        onChange={handleChange}
      />
      {dirty && <div style={{ position: 'absolute', top: 4, right: 12, width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />}
    </div>
  )
}

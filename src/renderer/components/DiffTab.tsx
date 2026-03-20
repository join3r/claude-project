import React, { useState, useEffect, Suspense } from 'react'

const LazyDiffEditor = React.lazy(() => import('@monaco-editor/react').then(m => ({ default: m.DiffEditor })))

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

  useEffect(() => {
    Promise.all([
      window.api.fbGitDiff(projectDir, filePath),
      window.api.fbReadFile(projectDir, filePath)
    ]).then(([orig, mod]) => {
      setOriginal(orig)
      setModified(mod)
    })
  }, [projectDir, filePath])

  if (!visible) return <div style={{ display: 'none' }} />
  if (original === null || modified === null) return <div className="tab-content-placeholder">Loading...</div>

  return (
    <div style={{ position: 'absolute', inset: 0, display: visible ? 'block' : 'none' }}>
      <Suspense fallback={<div className="tab-content-placeholder">Loading editor...</div>}>
        <LazyDiffEditor
          original={original}
          modified={modified}
          language={getLanguageFromPath(filePath)}
          theme={effectiveTheme === 'dark' ? 'vs-dark' : 'vs'}
          options={{
            readOnly: true,
            automaticLayout: true,
            minimap: { enabled: false }
          }}
        />
      </Suspense>
    </div>
  )
}

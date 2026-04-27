import React, { useState, useRef, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import { DEFAULT_CONFIG } from '../../shared/types'
import { useApp } from '../context/AppContext'
import { buildMonacoEditorOptions } from './monacoOptions'
import MarkdownPreview from './MarkdownPreview'
import './NoteTab.css'

interface Props {
  noteId: string
  projectId: string
  visible: boolean
  effectiveTheme: 'dark' | 'light'
}

export default function NoteTab({ noteId, projectId, visible, effectiveTheme }: Props): React.ReactElement {
  const { notes, updateNoteContent, config } = useApp()
  const note = notes[projectId]?.find(n => n.id === noteId) ?? null
  const [viewMode, setViewMode] = useState<'source' | 'preview'>('source')
  const currentContentRef = useRef<string>(note?.content ?? '')
  const monacoConfig = config ?? DEFAULT_CONFIG

  const handleToggleView = useCallback(() => {
    setViewMode(prev => prev === 'source' ? 'preview' : 'source')
  }, [])

  const handleChange = useCallback((value: string | undefined) => {
    const next = value ?? ''
    currentContentRef.current = next
    updateNoteContent(projectId, noteId, next)
  }, [projectId, noteId, updateNoteContent])

  if (!visible) return <div style={{ display: 'none' }} />
  if (!note) return <div className="tab-content-placeholder">Note not found.</div>

  return (
    <div className="note-tab">
      <div className="note-tab-header">
        <span className="note-tab-title">{note.name}</span>
        <button
          className="note-tab-toggle"
          onClick={handleToggleView}
          title={viewMode === 'source' ? 'Show preview' : 'Show source'}
        >
          {viewMode === 'source' ? 'Preview' : 'Source'}
        </button>
      </div>
      <div className="note-tab-body">
        <div style={{ display: viewMode === 'source' ? 'block' : 'none', position: 'absolute', inset: 0 }}>
          <Editor
            defaultValue={note.content}
            language="markdown"
            theme={effectiveTheme === 'dark' ? 'vs-dark' : 'vs'}
            options={buildMonacoEditorOptions(monacoConfig)}
            onChange={handleChange}
          />
        </div>
        {viewMode === 'preview' && (
          <MarkdownPreview content={currentContentRef.current} effectiveTheme={effectiveTheme} />
        )}
      </div>
    </div>
  )
}

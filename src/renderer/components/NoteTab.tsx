import React, { useState, useRef, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import { DEFAULT_CONFIG } from '../../shared/types'
import { useApp } from '../context/AppContext'
import { buildMonacoEditorOptions } from './monacoOptions'
import MarkdownPreview from './MarkdownPreview'

interface Props {
  noteId: string
  projectId: string
  taskId: string
  visible: boolean
  effectiveTheme: 'dark' | 'light'
}

export default function NoteTab({ noteId, projectId, taskId, visible, effectiveTheme }: Props): React.ReactElement {
  const { notes, updateNoteContent, config, markTaskInteracted } = useApp()
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
    markTaskInteracted(projectId, taskId)
    updateNoteContent(projectId, noteId, next)
  }, [projectId, taskId, noteId, updateNoteContent, markTaskInteracted])

  if (!visible) return <div style={{ display: 'none' }} />
  if (!note) return <div className="flex-1 flex items-center justify-center h-full text-text-muted text-base">Note not found.</div>

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center px-2 py-1 border-b border-hair bg-surface-2 shrink-0 gap-2">
        <span className="flex-1 text-base text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">{note.name}</span>
        <button
          className="bg-transparent border-0 p-0 text-sm text-accent cursor-pointer shrink-0 hover:underline"
          onClick={handleToggleView}
          title={viewMode === 'source' ? 'Show preview' : 'Show source'}
        >
          {viewMode === 'source' ? 'Preview' : 'Source'}
        </button>
      </div>
      <div className="flex-1 relative overflow-hidden">
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

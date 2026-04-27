import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import './NotesList.css'

export default function NotesList(): React.ReactElement {
  const {
    selectedProjectId,
    selectedTaskId,
    notes,
    createNote,
    renameNote,
    deleteNote,
    openOrFocusNoteTab
  } = useApp()

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const editInputRef = useRef<HTMLInputElement | null>(null)

  const projectNotes = selectedProjectId ? (notes[selectedProjectId] ?? []) : []

  useEffect(() => {
    if (editingNoteId && editInputRef.current) {
      editInputRef.current.select()
    }
  }, [editingNoteId])

  const handleCreate = useCallback(() => {
    if (!selectedProjectId) return
    const note = createNote(selectedProjectId, 'Untitled')
    setEditingNoteId(note.id)
    setEditingName('Untitled')
  }, [selectedProjectId, createNote])

  const handleRenameConfirm = useCallback(() => {
    if (!editingNoteId || !selectedProjectId) return
    const trimmed = editingName.trim()
    if (trimmed) renameNote(selectedProjectId, editingNoteId, trimmed)
    setEditingNoteId(null)
  }, [editingNoteId, editingName, selectedProjectId, renameNote])

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleRenameConfirm()
    if (e.key === 'Escape') setEditingNoteId(null)
  }, [handleRenameConfirm])

  const handleNoteClick = useCallback((noteId: string) => {
    if (!selectedProjectId || !selectedTaskId) return
    openOrFocusNoteTab(selectedProjectId, selectedTaskId, 'left', noteId)
  }, [selectedProjectId, selectedTaskId, openOrFocusNoteTab])

  const handleDoubleClick = useCallback((noteId: string, currentName: string) => {
    setEditingNoteId(noteId)
    setEditingName(currentName)
  }, [])

  const handleDelete = useCallback((e: React.MouseEvent, noteId: string) => {
    e.stopPropagation()
    if (!selectedProjectId) return
    deleteNote(selectedProjectId, noteId)
  }, [selectedProjectId, deleteNote])

  return (
    <div className="notes-list">
      <div className="notes-list-toolbar">
        <button className="notes-list-add-btn" onClick={handleCreate} title="New note">
          +
        </button>
      </div>
      <div className="notes-list-items">
        {projectNotes.length === 0 && (
          <div className="notes-list-empty">No notes yet</div>
        )}
        {projectNotes.map(note => (
          <div
            key={note.id}
            className="notes-list-item"
            onClick={() => editingNoteId !== note.id && handleNoteClick(note.id)}
            onDoubleClick={() => handleDoubleClick(note.id, note.name)}
          >
            {editingNoteId === note.id ? (
              <input
                ref={editInputRef}
                className="notes-list-item-rename"
                value={editingName}
                onChange={e => setEditingName(e.target.value)}
                onBlur={handleRenameConfirm}
                onKeyDown={handleRenameKeyDown}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className="notes-list-item-name">{note.name}</span>
            )}
            {editingNoteId !== note.id && (
              <button
                className="notes-list-delete-btn"
                onClick={e => handleDelete(e, note.id)}
                title="Delete note"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

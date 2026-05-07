import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Plus, X } from 'lucide-react'
import { useApp } from '../context/AppContext'

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
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-end px-2 py-1 border-b border-border shrink-0">
        <button className="bg-transparent border-0 cursor-pointer text-text-muted text-[18px] leading-none px-1 rounded-sm hover:text-text hover:bg-surface-2" onClick={handleCreate} title="New note">
          <Plus size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {projectNotes.length === 0 && (
          <div className="text-text-muted text-[12px] px-2 py-3 text-center italic">No notes yet</div>
        )}
        {projectNotes.map(note => (
          <div
            key={note.id}
            className="group flex items-center px-2 py-1 cursor-pointer select-none text-[13px] text-text gap-1 hover:bg-surface-2"
            onClick={() => editingNoteId !== note.id && handleNoteClick(note.id)}
            onDoubleClick={() => handleDoubleClick(note.id, note.name)}
          >
            {editingNoteId === note.id ? (
              <input
                ref={editInputRef}
                className="flex-1 bg-surface-2 border border-border-focus text-text text-[13px] px-1 rounded-sm outline-none min-w-0"
                value={editingName}
                onChange={e => setEditingName(e.target.value)}
                onBlur={handleRenameConfirm}
                onKeyDown={handleRenameKeyDown}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{note.name}</span>
            )}
            {editingNoteId !== note.id && (
              <button
                className="bg-transparent border-0 cursor-pointer text-text-muted text-[11px] px-1 py-0.5 rounded-sm shrink-0 leading-none opacity-0 group-hover:opacity-100 hover:bg-surface-2 hover:text-red-400 transition-opacity"
                onClick={e => handleDelete(e, note.id)}
                title="Delete note"
              >
                <X size={11} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

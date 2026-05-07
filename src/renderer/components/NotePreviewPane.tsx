import React from 'react'
import { useApp } from '../context/AppContext'
import type { Project } from '../../shared/types'
import MarkdownPreview from './MarkdownPreview'

interface Props {
  project: Project
  noteId: string
  onBack: () => void
}

export function NotePreviewPane({ project, noteId, onBack }: Props): React.ReactElement {
  const actions = useApp()
  const note = actions.notes[project.id]?.find(n => n.id === noteId)

  const onOpen = () => {
    if (!note) return
    const existingTaskId = project.tasks[0]?.id
    if (existingTaskId) {
      actions.setSelectedTaskId(existingTaskId)
      actions.openOrFocusNoteTab(project.id, existingTaskId, 'left', note.id)
      return
    }
    const task = actions.addTask(project.id, 'Notes')
    actions.addTab(project.id, task.id, 'left', 'note', { noteId: note.id, noteName: note.name })
  }

  return (
    <section className="px-4 py-3">
      <header className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-subtle hover:text-text bg-transparent border-0 cursor-pointer"
        >
          &larr; Back
        </button>
        {note && (
          <button
            type="button"
            onClick={onOpen}
            className="text-xs text-text-subtle hover:text-text bg-transparent border-0 cursor-pointer"
          >
            Open
          </button>
        )}
      </header>
      {!note ? (
        <div className="text-sm text-text-subtle">(note unavailable)</div>
      ) : (
        <>
          <h2 className="text-base font-semibold text-text mb-2 break-words">{note.name}</h2>
          {note.content.trim().length === 0 ? (
            <div className="text-sm text-text-subtle">(empty note)</div>
          ) : (
            <MarkdownPreview content={note.content} effectiveTheme={actions.effectiveTheme} variant="flow" />
          )}
        </>
      )}
    </section>
  )
}

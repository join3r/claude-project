import React from 'react'
import { useApp } from '../context/AppContext'
import { selectRecentNotes } from '../hooks/useAppState'
import type { Project, ProjectNote } from '../../shared/types'

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

interface Props { project: Project }

export function RecentNotesList({ project }: Props): React.ReactElement {
  const actions = useApp()
  const recent = selectRecentNotes(actions.notes, project.id, 8)

  const ensureTaskId = (): string => {
    const existing = project.tasks[0]?.id
    if (existing) return existing
    return actions.addTask(project.id, 'Notes').id
  }

  const onNew = () => {
    const note = actions.createNote(project.id, 'Untitled')
    const taskId = ensureTaskId()
    actions.addTab(project.id, taskId, 'left', 'note', { noteId: note.id, noteName: note.name })
  }

  const onOpen = (n: ProjectNote) => {
    const existingTaskId = project.tasks[0]?.id
    if (existingTaskId) {
      actions.openOrFocusNoteTab(project.id, existingTaskId, 'left', n.id)
      return
    }
    const task = actions.addTask(project.id, 'Notes')
    actions.addTab(project.id, task.id, 'left', 'note', { noteId: n.id, noteName: n.name })
  }

  return (
    <section className="px-4 py-3">
      <header className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-text-subtle">Recent Notes</h2>
        <button
          type="button"
          onClick={onNew}
          className="text-xs text-text-subtle hover:text-text bg-transparent border-0 cursor-pointer"
        >
          + New Note
        </button>
      </header>
      {recent.length === 0 ? (
        <div className="text-sm text-text-subtle">No notes yet.</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {recent.map(n => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onOpen(n)}
                className="w-full text-left px-2 py-1 rounded hover:bg-surface-2 bg-transparent border-0 cursor-pointer text-text flex items-center justify-between gap-3"
              >
                <span className="truncate">&#9658; {n.name}</span>
                <span className="text-xs text-text-subtle shrink-0">{timeAgo(n.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

import React, { useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import type { Project } from '../../../shared/types'
import { visibleArchive, type ArchivedTask } from '../../../shared/archive'
import { useProjectArchive } from '../../hooks/archiveStore'
import { useDoneRowActions } from '../sidebar/doneActions'
import { ContextMenu, RowAction, RowActions, type ContextMenuItem } from '../ui'

const cardLinkCls = 'bg-transparent border-0 p-0 text-xs cursor-pointer text-text-subtle hover:text-text hover:underline'

/**
 * An archived task under a lane's `Done N`: a click opens it read-only; hover
 * offers Reopen and Delete permanently…, as does a right-click.
 */
export function DoneTaskItem({ project, entry }: { project: Project; entry: ArchivedTask }): React.ReactElement {
  const actions = useDoneRowActions()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const open = () => actions.open({ projectId: project.id, kind: 'task', id: entry.task.id })
  const reopen = () => actions.reopenTask(project.id, entry.task.id)
  const remove = () => actions.deleteTask(project.id, entry)
  const items: ContextMenuItem[] = [
    { label: 'Open', onSelect: open },
    { label: 'Reopen', onSelect: reopen },
    { label: 'Delete permanently…', onSelect: remove, danger: true }
  ]
  return (
    <li className="group min-w-0 flex items-center gap-1 rounded-sm hover:bg-surface-3 px-1 -mx-1" data-testid={`home-archived-task-${entry.task.id}`}>
      <button
        type="button"
        className="flex-1 min-w-0 bg-transparent border-0 p-0 py-0.5 text-left text-xs text-text-muted cursor-pointer truncate"
        title={`${entry.task.name} · archived`}
        onClick={open}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
      >
        {entry.task.name}
      </button>
      <RowActions>
        <RowAction title="Reopen" onClick={reopen}>
          <RotateCcw size={12} />
        </RowAction>
        <RowAction danger title="Delete permanently…" onClick={remove}>
          <Trash2 size={12} />
        </RowAction>
      </RowActions>
      <ContextMenu menu={menu} items={menu ? items : []} onClose={() => setMenu(null)} />
    </li>
  )
}

/** "N archived streams": opens to their names, each opening read-only. */
export function ArchivedStreamsLine({ project }: { project: Project }): React.ReactElement | null {
  const { showArchived } = useApp()
  const [open, setOpen] = useState(false)
  const archive = useProjectArchive(project.id, open)
  const count = project.archivedStreamCount ?? 0
  if (count === 0) return null
  const streams = archive
    ? [...visibleArchive(archive, project).streams].sort((a, b) => b.archivedAt - a.archivedAt)
    : []
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-text-subtle">
      <button type="button" className={cardLinkCls} onClick={() => setOpen(!open)} aria-expanded={open}>
        {count} archived {count === 1 ? 'stream' : 'streams'}
      </button>
      {open && !archive && <span>Loading…</span>}
      {open && streams.map((entry, index) => (
        <React.Fragment key={entry.stream.id}>
          {index > 0 && <span aria-hidden>·</span>}
          <button
            type="button"
            className={`${cardLinkCls} font-mono`}
            title={`${entry.stream.name} · ${entry.stream.tasks.length + entry.doneTasks.length} tasks · archived`}
            onClick={() => showArchived({ projectId: project.id, kind: 'stream', id: entry.stream.id })}
          >
            {entry.stream.name}
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

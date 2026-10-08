import React, { useCallback, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { Project, Stream } from '../../../shared/types'
import { archivedTasksOf, visibleArchive, type ArchivedStream, type ArchivedTask } from '../../../shared/archive'
import { useProjectArchive } from '../../hooks/archiveStore'
import { useArchivedView, type ArchivedViewTarget } from '../archivedViewTarget'
import { ContextMenu, RowAction, RowActions, type ContextMenuItem } from '../ui'
import { formatActivityAge } from './streamTree'
import { DONE_ITEM_PL, STREAM_ROW_PL, TASK_ROW_PL, TreeChevron } from './SidebarParts'

export interface DoneRowActions {
  open: (target: ArchivedViewTarget) => void
  reopenTask: (projectId: string, taskId: string) => void
  reopenStream: (projectId: string, streamId: string) => void
  deleteTask: (projectId: string, entry: ArchivedTask) => void
  deleteStream: (projectId: string, entry: ArchivedStream) => void
}

const doneRowCls = 'group flex items-center gap-2 mx-1.5 px-2.5 h-[26px] rounded-md text-sm cursor-pointer transition-colors duration-(--motion-fast)'

function archivedAge(archivedAt: number, now: number): string {
  return formatActivityAge({ id: '', name: '', panes: [], lastInteractedAt: archivedAt }, now) ?? ''
}

/**
 * One archived item under a Done row: its name and when it was archived; hover
 * shows Reopen, right-click adds Delete permanently. A click opens it read-only.
 */
function DoneItemRow({ label, title, archivedAt, now, indentCls, selected, onOpen, onReopen, onDelete, testId }: {
  label: string
  title: string
  archivedAt: number
  now: number
  indentCls: string
  selected: boolean
  onOpen: () => void
  onReopen: () => void
  onDelete: () => void
  testId: string
}): React.ReactElement {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const items: ContextMenuItem[] = [
    { label: 'Open', onSelect: onOpen },
    { label: 'Reopen', onSelect: onReopen },
    { label: 'Delete permanently…', onSelect: onDelete, danger: true }
  ]
  return (
    <>
      <div
        className={[doneRowCls, indentCls, selected ? 'bg-sel text-text' : 'text-text-muted hover:bg-surface-3'].join(' ')}
        data-testid={testId}
        title={title}
        onClick={onOpen}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }) }}
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
        <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
          <span className="text-xs text-text-subtle tabular-nums group-hover:hidden">{archivedAge(archivedAt, now)}</span>
          <RowActions>
            <RowAction title="Reopen" onClick={onReopen}>
              <RotateCcw size={12} />
            </RowAction>
          </RowActions>
        </span>
      </div>
      <ContextMenu menu={menu} items={menu ? items : []} onClose={closeMenu} />
    </>
  )
}

function DoneHeader({ label, count, open, indentCls, onToggle, testId }: {
  label: string
  count: number
  open: boolean
  indentCls: string
  onToggle: () => void
  testId: string
}): React.ReactElement {
  return (
    <div
      className={[doneRowCls, indentCls, 'text-text-subtle hover:bg-surface-3'].join(' ')}
      data-testid={testId}
      onClick={onToggle}
    >
      <TreeChevron open={open} />
      <span>{label} ({count})</span>
    </div>
  )
}

/**
 * A stream's collapsed `Done (N)` row: its archived tasks. The archive file is
 * read only once the row is opened; N comes from the live data.
 */
export function StreamDoneRow({ project, stream, now, actions }: {
  project: Project
  stream: Stream
  now: number
  actions: DoneRowActions
}): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const archive = useProjectArchive(project.id, open)
  const view = useArchivedView()
  const count = stream.archivedTaskCount ?? 0
  if (count === 0) return null
  const tasks = archive ? archivedTasksOf(visibleArchive(archive, project), stream.id) : []
  return (
    <>
      <DoneHeader label="Done" count={count} open={open} indentCls={TASK_ROW_PL} onToggle={() => setOpen(!open)} testId={`done-tasks-${stream.id}`} />
      {open && !archive && <div className={`mx-1.5 px-2.5 ${DONE_ITEM_PL} h-6 text-xs text-text-subtle flex items-center`}>Loading…</div>}
      {open && tasks.map(entry => (
        <DoneItemRow
          key={entry.task.id}
          label={entry.task.name}
          title={`${entry.task.name} · archived`}
          archivedAt={entry.archivedAt}
          now={now}
          indentCls={DONE_ITEM_PL}
          selected={view?.kind === 'task' && view.id === entry.task.id}
          testId={`archived-task-${entry.task.id}`}
          onOpen={() => actions.open({ projectId: project.id, kind: 'task', id: entry.task.id })}
          onReopen={() => actions.reopenTask(project.id, entry.task.id)}
          onDelete={() => actions.deleteTask(project.id, entry)}
        />
      ))}
    </>
  )
}

/** The project's `Done` group: its archived streams. */
export function ProjectDoneGroup({ project, now, actions }: {
  project: Project
  now: number
  actions: DoneRowActions
}): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const archive = useProjectArchive(project.id, open)
  const view = useArchivedView()
  const count = project.archivedStreamCount ?? 0
  if (count === 0) return null
  const streams = archive
    ? [...visibleArchive(archive, project).streams].sort((a, b) => b.archivedAt - a.archivedAt)
    : []
  return (
    <>
      <DoneHeader label="Done" count={count} open={open} indentCls={STREAM_ROW_PL} onToggle={() => setOpen(!open)} testId={`done-streams-${project.id}`} />
      {open && !archive && <div className={`mx-1.5 px-2.5 ${TASK_ROW_PL} h-6 text-xs text-text-subtle flex items-center`}>Loading…</div>}
      {open && streams.map(entry => (
        <DoneItemRow
          key={entry.stream.id}
          label={entry.stream.workspace ? `${entry.stream.name} ⎇ ${entry.stream.workspace.branchName}` : entry.stream.name}
          title={`${entry.stream.name} · ${entry.stream.tasks.length + entry.doneTasks.length} tasks · archived`}
          archivedAt={entry.archivedAt}
          now={now}
          indentCls={TASK_ROW_PL}
          selected={view?.kind === 'stream' && view.id === entry.stream.id}
          testId={`archived-stream-${entry.stream.id}`}
          onOpen={() => actions.open({ projectId: project.id, kind: 'stream', id: entry.stream.id })}
          onReopen={() => actions.reopenStream(project.id, entry.stream.id)}
          onDelete={() => actions.deleteStream(project.id, entry)}
        />
      ))}
    </>
  )
}

import React, { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { isRemoteProject, isShellCommandProject, pinnedItemKey } from '../../../shared/types'
import type { PinnedItem, Project } from '../../../shared/types'
import { canMoveToServer } from '../../../shared/project-move'
import { findStreamOfTask, findTaskInProject, taskMoveBlocker } from '../../../shared/streams'
import { streamRunCommand } from '../../../shared/stream-run'
import { controlStreamRun, openStreamRunCommand, openStreamRunLogs, useStreamRun } from '../../streamRuns'
import { openEntityDialog, requestCloseStream } from '../../entityActions'
import { paletteEvents } from '../../palette/paletteEvents'
import { useMenuPosition, type MenuAnchor } from '../../hooks/useMenuPosition'
import { useMissingProjectDirs } from '../../hooks/useMissingProjectDirs'
import { useAddEmptyTask, useMoveTask } from '../../hooks/useTaskMenuActions'
import { revealInFolderLabel } from '../../utils/revealLabel'
import { menuCls, menuItemCls } from '../ui'
import { StreamRunStatusLabel } from '../StreamRunControls'
import { formatWaitTime } from '../inbox'
import {
  canTrashProjectFolder, projectDeletePrompt, projectDeleteWithFolderPrompt, revealFolder
} from './projectMenuRules'

/**
 * The project and stream menus, drawn the same wherever they show: the tree's
 * right-click, the Inbox's task menu (as pages), the task header's breadcrumb,
 * the Inbox's group headers and Project Home. Their dialogs open through
 * `entityActions` so none of them needs the tree on screen.
 */

const sectionCls = 'border-b border-hair pb-1 mb-1'
const dangerCls = `${menuItemCls} text-danger`

function isPinnedIn(pinnedItems: readonly PinnedItem[] | undefined, item: PinnedItem): boolean {
  const key = pinnedItemKey(item)
  return (pinnedItems ?? []).some(candidate => pinnedItemKey(candidate) === key)
}

function revealItem(folder: string | null, projectId: string, onDone: () => void): React.ReactElement | null {
  if (!folder) return null
  return (
    <button className={menuItemCls} onClick={() => {
      onDone()
      window.api.revealInFolder(folder, undefined, projectId).catch((err: unknown) => {
        window.alert(`Couldn't open ${folder}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }}>{revealInFolderLabel()}</button>
  )
}

/** A row that opens another page of the same menu (`Stream 0.5.0 ›`). */
export function SubmenuButton({ label, detail, onClick, testId }: {
  label: string
  /** The stream or project it is about, quieter than the label. */
  detail?: string
  onClick: () => void
  testId?: string
}): React.ReactElement {
  return (
    <button className={`${menuItemCls} flex items-center gap-6 justify-between`} onClick={onClick} data-testid={testId}>
      <span className="flex items-center gap-1.5 min-w-0">
        <span>{label}</span>
        {detail && <span className="text-text-subtle font-mono truncate max-w-[140px]">{detail}</span>}
      </span>
      <ChevronRight size={11} className="text-text-subtle shrink-0" />
    </button>
  )
}

/** A page's way back to the menu it opened from. */
export function SubmenuBack({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return (
    <div className={sectionCls}>
      <button className={`${menuItemCls} flex items-center gap-1.5 text-text-muted`} onClick={onClick}>
        <ChevronLeft size={11} className="shrink-0" />
        <span className="truncate max-w-[220px]">{label}</span>
      </button>
    </div>
  )
}

/** A stream's app run in its menu: Run (or Restart and Stop), Show logs, and its own command. */
export function StreamRunMenuItems({ project, streamId, onDone }: { project: Project; streamId: string; onDone: () => void }): React.ReactElement {
  const stream = project.streams.find(s => s.id === streamId)
  const run = useStreamRun(project.id, streamId)
  const command = streamRunCommand(project, stream)
  const running = run?.status === 'running'
  const act = (fn: () => void) => () => { onDone(); fn() }
  return (
    <div className={sectionCls}>
      {running ? (
        <>
          <button className={menuItemCls} onClick={act(() => void controlStreamRun(project.id, streamId, 'restart'))}>Restart app</button>
          <button className={menuItemCls} onClick={act(() => void controlStreamRun(project.id, streamId, 'stop'))}>Stop app</button>
        </>
      ) : (
        <button
          className={`${menuItemCls} disabled:opacity-50 disabled:cursor-default`}
          disabled={!command}
          title={command ? `$ ${command}` : 'Set a run command first'}
          onClick={act(() => void controlStreamRun(project.id, streamId, 'start'))}
        >Run app</button>
      )}
      {(run || command) && (
        <button className={menuItemCls} onClick={act(() => openStreamRunLogs({ projectId: project.id, streamId }))}>Show app logs</button>
      )}
      <button className={menuItemCls} onClick={act(() => openStreamRunCommand({ projectId: project.id, streamId }))}>Run command…</button>
    </div>
  )
}

/** The top of a stream menu shown on its own: its name and branch, how its app runs, and the command. */
export function StreamMenuHeader({ project, streamId }: { project: Project; streamId: string }): React.ReactElement | null {
  const stream = project.streams.find(s => s.id === streamId)
  const run = useStreamRun(project.id, streamId)
  if (!stream) return null
  const command = streamRunCommand(project, stream) ?? run?.command
  const running = run?.status === 'running'
  return (
    <div className={`${sectionCls} px-2.5 pt-1 max-w-[280px]`} data-testid="stream-menu-header">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-sm text-text truncate">{stream.name}</span>
        {stream.workspace && (
          <span className="font-mono text-2xs text-text-subtle truncate min-w-0">⎇ {stream.workspace.branchName}</span>
        )}
        <span className="flex-1" />
        {run && (
          <span className="flex items-center gap-1 shrink-0">
            <StreamRunStatusLabel run={run} />
            {running && <span className="text-xs text-text-subtle tabular-nums">· {formatWaitTime(Date.now() - run.startedAt)}</span>}
          </span>
        )}
      </div>
      {command && (
        <div className="font-mono text-xs text-text-subtle truncate pb-0.5" title={command}>$ {command}</div>
      )}
    </div>
  )
}

/**
 * A stream's menu: New task, its app (Run / Restart / Stop, logs, command),
 * Rename, Pin, Reveal, Close (never `main`).
 */
export function StreamMenuItems({ project, streamId, onDone, onRenameInline, onCloseStream, newTaskLabel = 'New task' }: {
  project: Project
  streamId: string
  /** Closes the menu; called before the item's action. */
  onDone: () => void
  /** The tree renames in place; elsewhere a small dialog asks. */
  onRenameInline?: () => void
  /** The tree's own close flow; elsewhere the window's (`requestCloseStream`). */
  onCloseStream?: () => void
  newTaskLabel?: string
}): React.ReactElement | null {
  const { projects, pinnedItems, togglePinnedItem } = useApp()
  const addEmptyTask = useAddEmptyTask()
  const stream = project.streams.find(s => s.id === streamId)
  if (!stream) return null
  const act = (fn: () => void) => () => { onDone(); fn() }
  const pin: PinnedItem = { type: 'stream', projectId: project.id, streamId }
  return (
    <>
      <div className={sectionCls}>
        <button className={menuItemCls} onClick={act(() => addEmptyTask(project.id, streamId))}>{newTaskLabel}</button>
      </div>
      {!isShellCommandProject(project) && <StreamRunMenuItems project={project} streamId={streamId} onDone={onDone} />}
      <button className={menuItemCls} onClick={act(() => {
        if (onRenameInline) onRenameInline()
        else openEntityDialog({ kind: 'rename', projectId: project.id, streamId })
      })}>Rename</button>
      <button className={menuItemCls} onClick={act(() => togglePinnedItem(pin))}>
        {isPinnedIn(pinnedItems, pin) ? 'Unpin stream' : 'Pin stream'}
      </button>
      {revealItem(revealFolder(projects, project.id, undefined, streamId), project.id, onDone)}
      {/* `main` can't be closed, only emptied. */}
      {!stream.isMain && (
        <button className={dangerCls} onClick={act(() => {
          if (onCloseStream) onCloseStream()
          else requestCloseStream(project.id, streamId)
        })}>Close stream</button>
      )}
    </>
  )
}

interface ProjectMenuProps {
  project: Project
  /** Closes the menu; called before the item's action. */
  onDone: () => void
  /** The project's folder is gone (the tree knows already); checked here when left out. */
  folderMissing?: boolean
  /** The tree renames a project without a folder in place; elsewhere a small dialog asks. */
  onRenameInline?: () => void
}

/** Whether Rename… opens the dialog that can rename the folder too. */
function renamesFolder(project: Project): boolean {
  return !isRemoteProject(project) && !isShellCommandProject(project) && !!project.directory
}

/**
 * A project's menu: New task, New stream…, Rename, Pin, Duplicate, Settings,
 * Reconnect SSH, Move to a DevTool server…, Reveal, Delete…, Delete with
 * folder…, and where it lives.
 */
export function ProjectMenuItems(props: ProjectMenuProps): React.ReactElement {
  if (props.folderMissing !== undefined) return <ProjectMenuBody {...props} folderMissing={props.folderMissing} />
  return <ProjectMenuCheckingFolder {...props} />
}

function ProjectMenuCheckingFolder(props: ProjectMenuProps): React.ReactElement {
  const missing = useMissingProjectDirs([props.project])
  return <ProjectMenuBody {...props} folderMissing={missing.has(props.project.id)} />
}

function ProjectMenuBody({ project, onDone, folderMissing, onRenameInline }: ProjectMenuProps & { folderMissing: boolean }): React.ReactElement {
  const { projects, pinnedItems, togglePinnedItem, connectSsh, removeProject } = useApp()
  const addEmptyTask = useAddEmptyTask()
  const act = (fn: () => void) => () => { onDone(); fn() }
  const pin: PinnedItem = { type: 'project', projectId: project.id }
  const folderRename = renamesFolder(project)

  const details: { label: string; value: string }[] = []
  if (isShellCommandProject(project)) {
    details.push({ label: 'Command', value: project.shellCommand!.command })
  } else if (isRemoteProject(project)) {
    details.push({ label: 'Connection', value: `${project.ssh!.username}@${project.ssh!.host}:${project.ssh!.port}` })
    details.push({ label: 'Dir', value: project.ssh!.remoteDir || '(remote home)' })
  } else {
    details.push({ label: 'Dir', value: project.directory })
  }

  return (
    <>
      <div className={sectionCls}>
        <button className={menuItemCls} onClick={act(() => addEmptyTask(project.id))}>New task</button>
        <button className={menuItemCls} onClick={act(() => paletteEvents.emit('open-new-stream', project.id))}>New stream…</button>
      </div>
      <button className={menuItemCls} onClick={act(() => {
        if (folderRename) openEntityDialog({ kind: 'rename-project', projectId: project.id })
        else if (onRenameInline) onRenameInline()
        else openEntityDialog({ kind: 'rename', projectId: project.id })
      })}>{folderRename ? 'Rename…' : 'Rename'}</button>
      <button className={menuItemCls} onClick={act(() => togglePinnedItem(pin))}>
        {isPinnedIn(pinnedItems, pin) ? 'Unpin project' : 'Pin project'}
      </button>
      <button className={menuItemCls} onClick={act(() => openEntityDialog({ kind: 'duplicate-project', projectId: project.id }))}>Duplicate</button>
      <button className={menuItemCls} onClick={act(() => openEntityDialog({ kind: 'project-settings', projectId: project.id }))}>Settings</button>
      {isRemoteProject(project) && (
        <button className={menuItemCls} onClick={act(() => { connectSsh(project.id, project.ssh!).catch(() => {}) })}>Reconnect SSH</button>
      )}
      {canMoveToServer(project) && (
        <button className={menuItemCls} onClick={act(() => openEntityDialog({ kind: 'move-to-server', project }))}>Move to a DevTool server…</button>
      )}
      {revealItem(revealFolder(projects, project.id), project.id, onDone)}
      <button className={dangerCls} onClick={act(() => {
        if (!window.confirm(projectDeletePrompt(project))) return
        void removeProject(project.id)
      })}>Delete…</button>
      {canTrashProjectFolder(project, folderMissing) && (
        <button className={dangerCls} onClick={act(() => {
          if (!window.confirm(projectDeleteWithFolderPrompt(project))) return
          void removeProject(project.id, { trashDirectory: true })
        })}>Delete with folder…</button>
      )}
      <div className="border-t border-hair mt-1 px-2.5 pt-1.5 pb-1">
        {details.map(d => (
          <div key={d.label} className="text-text-subtle text-xs leading-snug overflow-hidden text-ellipsis whitespace-nowrap max-w-[260px] select-text cursor-text" title={d.value}>
            <span className="opacity-70">{d.label}:</span> {d.value}
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * "Move to stream": the project's other streams, the menu's version of
 * dragging a task in the tree. A task with a worktree of its own can't leave
 * its stream; its rows say why.
 */
export function MoveToStreamItems({ project, taskId, onDone }: { project: Project; taskId: string; onDone: () => void }): React.ReactElement {
  const moveTask = useMoveTask()
  const task = findTaskInProject(project, taskId)
  const from = findStreamOfTask(project, taskId)
  const others = project.streams.filter(stream => stream.id !== from?.id)
  return (
    <>
      {others.map(stream => {
        const blocked = task && from ? taskMoveBlocker(task, from, stream) : null
        return (
          <button
            key={stream.id}
            className={`${menuItemCls} flex items-center gap-6 justify-between disabled:opacity-50 disabled:cursor-default`}
            disabled={!!blocked}
            title={blocked ?? undefined}
            data-testid={`move-to-stream-${stream.id}`}
            onClick={() => {
              onDone()
              moveTask(project.id, taskId, stream.id)
            }}
          >
            <span className="font-mono truncate max-w-[200px]">{stream.name}</span>
            {stream.workspace && <span className="text-text-subtle text-xs font-mono truncate max-w-[120px]">⎇ {stream.workspace.branchName}</span>}
          </button>
        )
      })}
    </>
  )
}

/** Where a stream or project menu was opened, and for what. */
export type EntityMenuTarget = MenuAnchor & {
  kind: 'project' | 'stream'
  projectId: string
  streamId?: string
  /**
   * A project menu opened for a task in this stream (the task header, where
   * `main` has no name of its own to click): it also offers that stream's menu.
   */
  withStreamId?: string
}

/**
 * A stream or project menu on its own, as a dropdown at `menu`. Any click
 * outside, another right-click or Escape closes it.
 */
export function EntityMenuPopup({ menu, onClose }: { menu: EntityMenuTarget | null; onClose: () => void }): React.ReactElement | null {
  const { projects } = useApp()
  const [page, setPage] = useState<'root' | 'stream'>('root')
  const position = useMenuPosition<HTMLDivElement>(menu)
  useEffect(() => { setPage('root') }, [menu])

  useEffect(() => {
    if (!menu) return
    const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menu, onClose])

  if (!menu) return null
  const project = projects.find(p => p.id === menu.projectId)
  if (!project) return null
  const streamId = menu.kind === 'stream' ? menu.streamId : page === 'stream' ? menu.withStreamId : undefined
  const stream = streamId ? project.streams.find(s => s.id === streamId) : undefined
  const ownStream = menu.withStreamId ? project.streams.find(s => s.id === menu.withStreamId) : undefined

  return (
    <>
      <div
        className="fixed inset-0 z-(--z-menu)"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div
        ref={position.ref}
        role="menu"
        className={`fixed z-(--z-menu) min-w-[200px] ${menuCls}`}
        style={position.style}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid={stream ? 'stream-menu' : 'project-menu'}
      >
        {stream ? (
          <>
            {menu.kind === 'project' && <SubmenuBack label={project.name} onClick={() => setPage('root')} />}
            <StreamMenuHeader project={project} streamId={stream.id} />
            <StreamMenuItems project={project} streamId={stream.id} onDone={onClose} newTaskLabel={`New task in ${stream.name}`} />
          </>
        ) : (
          <>
            {ownStream && (
              <div className={sectionCls}>
                <SubmenuButton label="Stream" detail={ownStream.name} onClick={() => setPage('stream')} testId="project-menu-stream" />
              </div>
            )}
            <ProjectMenuItems project={project} onDone={onClose} />
          </>
        )}
      </div>
    </>
  )
}

import React from 'react'
import { Play, RotateCw, Square } from 'lucide-react'
import { canRunAppInTask, streamRunCommands, streamRunCrashed, type StreamRunAction, type StreamRunState } from '../../shared/stream-run'
import type { Project, Stream, Task } from '../../shared/types'
import {
  badgeRun, controlStreamRun, openStreamRunCommands, openStreamRunLogs, openStreamRunPicker, useStreamRuns,
  type StreamRunPickerTarget
} from '../streamRuns'
import { useApp } from '../context/AppContext'
import { ContextMenu, type ContextMenuItem } from './ui'

/** What a run's state reads as: "Running", "Exited (1)", "Stopped". */
export function streamRunLabel(run: StreamRunState | undefined): string | null {
  if (!run) return null
  if (run.status === 'running') return 'Running'
  if (run.status === 'stopped') return 'Stopped'
  return run.exitCode === 0 ? 'Exited' : `Exited (${run.exitCode ?? '?'})`
}

function runTone(run: StreamRunState | undefined): string {
  if (run?.status === 'running') return 'text-success'
  if (run?.status === 'exited' && run.exitCode !== 0) return 'text-danger'
  return 'text-text-subtle'
}

/** `taskName`: the task whose worktree the run is in (`streamRunTask`). */
export function StreamRunStatusLabel({ run, taskName }: { run: StreamRunState | undefined; taskName?: string }): React.ReactElement | null {
  const label = streamRunLabel(run)
  if (!label) return null
  return (
    <span className={`flex items-center gap-1.5 text-xs whitespace-nowrap ${runTone(run)}`} data-run-status={run?.status}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
      {taskName && (
        <span className="text-text-subtle min-w-0 truncate" title={`In ${taskName}'s worktree`} data-testid="run-task">
          in <span className="font-mono">{taskName}</span>
        </span>
      )}
    </span>
  )
}

interface ButtonsProps {
  run: StreamRunState | undefined
  /** The command is still set: Run and Restart can start it. */
  canRun: boolean
  onAction: (action: StreamRunAction) => void
  /** `md` buttons carry their names (the logs view, Project Home); `sm` are bare icons. */
  size?: 'sm' | 'md'
  /** The command's name, for Run's tooltip before it ever ran. */
  name?: string
}

/** Run when the app isn't running; Restart and Stop while it is. */
export function StreamRunButtons({ run, canRun, onAction, size = 'sm', name }: ButtonsProps): React.ReactElement {
  const running = run?.status === 'running'
  const button = (action: StreamRunAction, label: string, icon: React.ReactNode, title: string, disabled = false) => (
    <button
      key={action}
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onAction(action) }}
      className={[
        'flex items-center gap-1.5 rounded-md bg-transparent border-0 cursor-pointer text-text-muted',
        'hover:text-text hover:bg-sel disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent',
        'transition-colors duration-(--motion-fast)',
        size === 'md' ? 'h-(--ctl-h-sm) px-2 text-xs' : 'justify-center size-(--ctl-h-sm)'
      ].join(' ')}
    >
      {icon}
      {size === 'md' && label}
    </button>
  )
  const iconSize = size === 'md' ? 12 : 13
  if (!running) {
    return button('start', 'Run', <Play size={iconSize} />, canRun ? `Run ${run?.name ?? name ?? 'it'}` : 'This command is no longer set', !canRun)
  }
  return (
    <>
      {canRun && button('restart', 'Restart', <RotateCw size={iconSize} />, `Restart ${run.name}`)}
      {button('stop', 'Stop', <Square size={iconSize} />, `Stop ${run.name}`)}
    </>
  )
}

/**
 * The task header's sign of its stream's commands: lit while one runs, red after one
 * failed. Nothing once they were stopped or ended cleanly. A click opens its logs.
 */
export function StreamRunBadge({ run, onClick }: { run: StreamRunState | undefined; onClick: () => void }): React.ReactElement | null {
  if (!run) return null
  const failed = streamRunCrashed(run)
  if (run.status !== 'running' && !failed) return null
  return (
    <button
      type="button"
      title={`${run.name} ${streamRunLabel(run)?.toLowerCase()} · show logs`}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`flex items-center justify-center size-4 rounded-sm bg-transparent border-0 cursor-pointer hover:bg-sel ${runTone(run)}`}
      data-run-badge={run.status}
    >
      <Play size={10} fill="currentColor" />
    </button>
  )
}

interface StreamProps {
  projectId: string
  streamId: string
}

/** {@link StreamRunBadge} for this stream's runs (the task header, beside the stream's name). */
export function SidebarStreamRunBadge({ projectId, streamId }: StreamProps): React.ReactElement | null {
  const run = badgeRun(useStreamRuns(projectId, streamId))
  return <StreamRunBadge run={run} onClick={() => run && openStreamRunLogs({ projectId, streamId, commandId: run.commandId })} />
}

/** One item of a run menu: the picker, a stream's menu, a task's menu. */
export interface RunMenuEntry { label: string; hint?: string; title?: string; dividerBefore?: boolean; onSelect: () => void }

/**
 * Each of the stream's commands as menu items: Run (Run … here in a task's
 * worktree), or Restart and Stop while it runs (here), and its logs once it ran
 * (here). A command removed while it still runs keeps Stop and its logs.
 */
export function streamRunMenuEntries(
  project: Project, stream: Stream | undefined, runs: readonly StreamRunState[], task?: Task
): RunMenuEntry[] {
  if (!stream) return []
  const commands = streamRunCommands(project, stream)
  const taskId = task?.workspace ? task.id : undefined
  const ids = new Set(commands.map(c => c.id))
  const orphans = runs.filter(run => !ids.has(run.commandId) && run.status === 'running')
  const rows = [...commands.map(c => ({ id: c.id, name: c.name, command: c.command, removed: false })),
    ...orphans.map(run => ({ id: run.commandId, name: run.name, command: run.command, removed: true }))]
  const groups: RunMenuEntry[][] = []
  rows.forEach((row) => {
    const group: RunMenuEntry[] = []
    groups.push(group)
    const run = runs.find(r => r.commandId === row.id)
    const here = !task || run?.taskId === taskId
    const running = run?.status === 'running'
    const control = (action: StreamRunAction) => () => void controlStreamRun(project.id, stream.id, row.id, action, taskId)
    if (running && here) {
      if (!row.removed) group.push({ label: `Restart ${row.name}`, hint: 'running', title: `$ ${run.command}`, onSelect: control('restart') })
      group.push({ label: `Stop ${row.name}`, onSelect: () => void controlStreamRun(project.id, stream.id, row.id, 'stop') })
    } else if (!row.removed) {
      group.push({
        label: task ? `Run ${row.name} here` : `Run ${row.name}`,
        hint: running ? 'moves it' : undefined,
        title: running ? `Moves ${row.name} here from where it runs: $ ${row.command}` : `$ ${row.command}`,
        onSelect: control('start')
      })
    }
    if (run && here) {
      group.push({ label: `${row.name} logs`, onSelect: () => openStreamRunLogs({ projectId: project.id, streamId: stream.id, commandId: row.id }) })
    }
  })
  // A rule sets off a command with several items (one that ran); plain Run items sit together.
  const entries: RunMenuEntry[] = []
  let previous: RunMenuEntry[] | null = null
  for (const group of groups) {
    if (group.length === 0) continue
    if (previous && (group.length > 1 || previous.length > 1)) group[0].dividerBefore = true
    entries.push(...group)
    previous = group
  }
  return entries
}

/**
 * A task's menus offer its stream's commands in its own worktree through one
 * item, Run here…, which opens the picker; its hint counts what runs here.
 * Null unless the task has a worktree of its own and the stream has commands.
 */
export function taskRunMenuEntry(
  project: Project, stream: Stream | undefined, task: Task, runs: readonly StreamRunState[], at: { x: number; y: number }
): RunMenuEntry | null {
  if (!stream || !canRunAppInTask(project, stream, task)) return null
  const here = runs.filter(run => run.taskId === task.id && run.status === 'running').length
  return {
    label: 'Run here…',
    hint: here > 0 ? `${here} running` : undefined,
    title: `Run one of ${stream.name}'s commands in this task's worktree`,
    onSelect: () => openStreamRunPicker({ projectId: project.id, streamId: stream.id, taskId: task.id, ...at })
  }
}

/** {@link taskRunMenuEntry} as a menu section. */
export function TaskRunMenuItems({ project, stream, task, at, itemClassName, onDone }: {
  project: Project
  stream: Stream | undefined
  task: Task
  /** Where the menu is: the picker opens there. */
  at: { x: number; y: number }
  itemClassName: string
  /** Closes the menu; called before the item's action. */
  onDone: () => void
}): React.ReactElement | null {
  const runs = useStreamRuns(project.id, stream?.id ?? '')
  const entry = taskRunMenuEntry(project, stream, task, runs, at)
  if (!entry) return null
  return (
    <div className="border-b border-hair pb-1 mb-1" data-testid="task-menu-run">
      <button
        className={`${itemClassName} flex items-center gap-6 justify-between`}
        title={entry.title}
        onClick={() => { onDone(); entry.onSelect() }}
      >
        <span>{entry.label}</span>
        {entry.hint && <span className="text-text-subtle text-xs">{entry.hint}</span>}
      </button>
    </div>
  )
}

/** The picker Run opens: the stream's commands, in a task's worktree when it names one, and Edit commands…. */
export function StreamRunPicker({ projectId, streamId, x, y, taskId, onClose }: StreamRunPickerTarget & { onClose: () => void }): React.ReactElement | null {
  const { projects } = useApp()
  const project = projects.find(p => p.id === projectId)
  const stream = project?.streams.find(s => s.id === streamId)
  const task = taskId ? stream?.tasks.find(t => t.id === taskId) : undefined
  const runs = useStreamRuns(projectId, streamId)
  if (!project || !stream) return null
  const items: ContextMenuItem[] = streamRunMenuEntries(project, stream, runs, task)
  items.push({
    label: 'Edit commands…',
    dividerBefore: items.length > 0,
    onSelect: () => openStreamRunCommands({ projectId, streamId })
  })
  return <ContextMenu menu={{ x, y }} items={items} onClose={onClose} />
}

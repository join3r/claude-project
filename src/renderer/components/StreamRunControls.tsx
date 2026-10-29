import React from 'react'
import { Play, RotateCw, Square } from 'lucide-react'
import { canRunAppInTask, streamRunCommand, type StreamRunAction, type StreamRunState } from '../../shared/stream-run'
import type { Project, Stream, Task } from '../../shared/types'
import { controlStreamRun, openStreamRunLogs, useProjectStreamRun, useStreamRun } from '../streamRuns'
import { RowAction } from './ui'

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

/** A task's own app entries (its menus): Run app here, or Restart, Stop and logs while the stream's app runs in it. */
export interface TaskRunMenuEntry { label: string; title?: string; onSelect: () => void }

export function taskRunMenuEntries(project: Project, stream: Stream | undefined, task: Task, run: StreamRunState | undefined): TaskRunMenuEntry[] {
  if (!stream || !canRunAppInTask(project, stream, task)) return []
  const command = streamRunCommand(project, stream)
  const here = run?.taskId === task.id
  if (here && run?.status === 'running') {
    return [
      { label: 'Restart app', onSelect: () => void controlStreamRun(project.id, stream.id, 'restart', task.id) },
      { label: 'Stop app', onSelect: () => void controlStreamRun(project.id, stream.id, 'stop') },
      { label: 'Show app logs', onSelect: () => openStreamRunLogs({ projectId: project.id, streamId: stream.id }) }
    ]
  }
  const elsewhere = run?.status === 'running'
  const entries: TaskRunMenuEntry[] = [{
    label: 'Run app here',
    title: elsewhere ? `Moves ${stream.name}'s app here: $ ${command}` : `$ ${command}`,
    onSelect: () => void controlStreamRun(project.id, stream.id, 'start', task.id)
  }]
  if (here) entries.push({ label: 'Show app logs', onSelect: () => openStreamRunLogs({ projectId: project.id, streamId: stream.id }) })
  return entries
}

interface ButtonsProps {
  run: StreamRunState | undefined
  /** A command is set: Run can start something. */
  canRun: boolean
  onAction: (action: StreamRunAction) => void
  /** `md` buttons carry their names (the logs view, Project Home); `sm` are bare icons. */
  size?: 'sm' | 'md'
}

/** Run when the app isn't running; Restart and Stop while it is. */
export function StreamRunButtons({ run, canRun, onAction, size = 'sm' }: ButtonsProps): React.ReactElement {
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
    return button('start', 'Run', <Play size={iconSize} />, canRun ? 'Run the app' : 'No run command set', !canRun)
  }
  return (
    <>
      {button('restart', 'Restart', <RotateCw size={iconSize} />, 'Restart the app')}
      {button('stop', 'Stop', <Square size={iconSize} />, 'Stop the app')}
    </>
  )
}

/**
 * The sidebar's sign of a stream's app: lit while it runs, red after it failed.
 * Nothing once it was stopped or ended cleanly. A click opens its logs.
 */
export function StreamRunBadge({ run, onClick }: { run: StreamRunState | undefined; onClick: () => void }): React.ReactElement | null {
  if (!run) return null
  const failed = run.status === 'exited' && run.exitCode !== 0
  if (run.status !== 'running' && !failed) return null
  return (
    <button
      type="button"
      title={`App ${streamRunLabel(run)?.toLowerCase()} · show logs`}
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
  /** The stream's run command (`streamRunCommand`), if any. */
  command: string | undefined
}

/** The sidebar stream row's always-visible part: {@link StreamRunBadge} for this stream. */
export function SidebarStreamRunBadge({ projectId, streamId }: StreamProps): React.ReactElement | null {
  const run = useStreamRun(projectId, streamId)
  return <StreamRunBadge run={run} onClick={() => openStreamRunLogs({ projectId, streamId })} />
}

/** The sidebar stream row's hover action: Run, or Stop while it runs. */
export function SidebarStreamRunAction({ projectId, streamId, command }: StreamProps): React.ReactElement | null {
  const run = useStreamRun(projectId, streamId)
  const running = run?.status === 'running'
  if (!command && !running) return null
  return (
    <RowAction
      title={running ? 'Stop the app' : `Run the app: ${command}`}
      onClick={() => void controlStreamRun(projectId, streamId, running ? 'stop' : 'start')}
    >
      {running ? <Square size={12} /> : <Play size={13} />}
    </RowAction>
  )
}

/** {@link taskRunMenuEntries} as a menu section of buttons; nothing when the task can't run the app. */
export function TaskRunMenuItems({ project, stream, task, itemClassName, onDone }: {
  project: Project
  stream: Stream | undefined
  task: Task
  itemClassName: string
  /** Closes the menu; called before the item's action. */
  onDone: () => void
}): React.ReactElement | null {
  const run = useStreamRun(project.id, stream?.id ?? '')
  const entries = taskRunMenuEntries(project, stream, task, run)
  if (entries.length === 0) return null
  return (
    <div className="border-b border-hair pb-1 mb-1" data-testid="task-menu-run">
      {entries.map(entry => (
        <button key={entry.label} className={itemClassName} title={entry.title} onClick={() => { onDone(); entry.onSelect() }}>
          {entry.label}
        </button>
      ))}
    </div>
  )
}

/** A project's sign of its streams' apps: the badge of the one running (else the one that failed). */
export function ProjectStreamRunBadge({ projectId, streamIds }: { projectId: string; streamIds: readonly string[] }): React.ReactElement | null {
  const shown = useProjectStreamRun(projectId, streamIds)
  if (!shown) return null
  return <StreamRunBadge run={shown.run} onClick={() => openStreamRunLogs({ projectId, streamId: shown.streamId })} />
}

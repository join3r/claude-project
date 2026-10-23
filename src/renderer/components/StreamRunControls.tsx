import React from 'react'
import { Play, RotateCw, Square } from 'lucide-react'
import type { StreamRunAction, StreamRunState } from '../../shared/stream-run'
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

export function StreamRunStatusLabel({ run }: { run: StreamRunState | undefined }): React.ReactElement | null {
  const label = streamRunLabel(run)
  if (!label) return null
  return (
    <span className={`flex items-center gap-1.5 text-xs whitespace-nowrap ${runTone(run)}`} data-run-status={run?.status}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
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

/** A project's sign of its streams' apps: the badge of the one running (else the one that failed). */
export function ProjectStreamRunBadge({ projectId, streamIds }: { projectId: string; streamIds: readonly string[] }): React.ReactElement | null {
  const shown = useProjectStreamRun(projectId, streamIds)
  if (!shown) return null
  return <StreamRunBadge run={shown.run} onClick={() => openStreamRunLogs({ projectId, streamId: shown.streamId })} />
}

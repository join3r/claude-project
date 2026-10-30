import React from 'react'
import type { Project, Stream, Task } from '../../../shared/types'
import { streamWorktreeSupported } from '../../../shared/streams'
import { paletteEvents } from '../../palette/paletteEvents'
import { sameFolderWarning } from './deskStart'

/**
 * Under a new task's prompt when another agent is already working in the
 * folder it would start in (see `busyInSameFolder`). In the compose box,
 * New stream… makes a worktree, then aims the box at it; the full form has
 * its own stream picker instead.
 */
export default function SameFolderWarning({ project, stream, busy, offerStream = true }: {
  project: Project
  stream: Stream | undefined
  busy: readonly Task[]
  offerStream?: boolean
}): React.ReactElement | null {
  if (busy.length === 0) return null
  const canBranch = offerStream && streamWorktreeSupported(project)
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-sm text-text"
      title={busy.map(task => task.name).join(', ')}
      data-testid="same-folder-warning"
    >
      <span className="mt-[5px] w-1.5 h-1.5 rounded-full shrink-0 bg-warn" />
      <span className="flex-1 min-w-0">{sameFolderWarning(project, stream, busy)}</span>
      {canBranch && (
        <button
          type="button"
          className="shrink-0 bg-transparent border-0 p-0 text-sm text-accent cursor-pointer hover:underline"
          onClick={() => paletteEvents.emit('open-new-stream-for-task', project.id)}
          data-testid="same-folder-new-stream"
        >New stream…</button>
      )}
    </div>
  )
}

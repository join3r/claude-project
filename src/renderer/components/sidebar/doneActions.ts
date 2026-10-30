import { useMemo } from 'react'
import { useApp } from '../../context/AppContext'
import { openEntityDialog } from '../../entityActions'
import { closeArchivedView, getArchivedView, type ArchivedViewTarget } from '../archivedViewTarget'
import type { ArchivedStream, ArchivedTask } from '../../../shared/archive'

/** What an archived task or stream offers: open read-only, reopen, delete for good. */
export interface DoneRowActions {
  open: (target: ArchivedViewTarget) => void
  reopenTask: (projectId: string, taskId: string) => void
  reopenStream: (projectId: string, streamId: string) => void
  deleteTask: (projectId: string, entry: ArchivedTask) => void
  deleteStream: (projectId: string, entry: ArchivedStream) => void
}

type ReopenStream = ReturnType<typeof useApp>['reopenStream']

/**
 * Reopen an archived stream. Its worktree comes back from the branch and its
 * setup commands wait for approval, as for a new stream; a notice (its branch
 * went) or a failed setup is said. Rejects when the reopen itself fails.
 */
export async function reopenStreamWithSetup(reopenStream: ReopenStream, projectId: string, streamId: string): Promise<void> {
  const { notice, setup } = await reopenStream(projectId, streamId)
  if (notice) window.alert(notice)
  if (setup?.pending) openEntityDialog({ kind: 'stream-setup', projectId, streamId, branch: setup.branch, pending: setup.pending })
  else if (setup?.error) window.alert(`The worktree of the reopened stream is back, but its setup failed:\n\n${setup.error}`)
}

/** What archived rows do (a lane's Done list, the read-only view): open read-only, reopen, delete for good (after a confirm). */
export function useDoneRowActions(): DoneRowActions {
  const { showArchived, reopenTask, reopenStream, deleteArchived } = useApp()
  return useMemo(() => ({
    open: showArchived,
    reopenTask: (projectId, taskId) => {
      if (getArchivedView()?.id === taskId) closeArchivedView()
      void reopenTask(projectId, taskId)
    },
    reopenStream: (projectId, streamId) => {
      reopenStreamWithSetup(reopenStream, projectId, streamId).catch((err: unknown) => {
        window.alert(`Couldn't reopen the stream: ${err instanceof Error ? err.message : String(err)}`)
      })
    },
    deleteTask: (projectId, entry) => {
      if (!window.confirm(`Delete "${entry.task.name}" permanently? It can't be reopened afterwards. The agent's own session files are kept.`)) return
      if (getArchivedView()?.id === entry.task.id) closeArchivedView()
      void deleteArchived(projectId, { tasks: [entry.task.id] })
    },
    deleteStream: (projectId, entry) => {
      const count = entry.stream.tasks.length + entry.doneTasks.length
      if (!window.confirm(`Delete stream "${entry.stream.name}" and its ${count} ${count === 1 ? 'task' : 'tasks'} permanently? It can't be reopened afterwards. Its branch and the agents' session files are kept.`)) return
      if (getArchivedView()?.id === entry.stream.id) closeArchivedView()
      void deleteArchived(projectId, { streams: [entry.stream.id] })
    }
  }), [showArchived, reopenTask, reopenStream, deleteArchived])
}

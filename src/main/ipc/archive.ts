import type { SshConfig } from '../../shared/types'
import {
  withArchivedStream,
  withArchivedTasks,
  withoutArchived,
  type ArchivedStream,
  type ArchivedTask,
  type ProjectArchive
} from '../../shared/archive'
import type { ArchiveStorage } from '../archive-storage'
import type { IpcRegistrar } from './registrar'
import { archivedStreamEntry, archivedTaskEntry, optSafeId, optSshConfig, safeId } from './schemas'
import { v } from './validate'

export interface ArchiveDeps {
  archive: ArchiveStorage
  /** Every window re-reads a project's archive it has open. */
  broadcastChanged: (projectId: string) => void
  /** Scrollback of tabs deleted for good. */
  deleteScrollback: (tabId: string) => void
  /** A Claude session's messages, for the read-only view of an archived task. */
  readTranscript: (sessionId: string, cwd: string, projectId?: string, sshConfig?: SshConfig) => Promise<unknown[]>
}

/**
 * Archived tasks and streams (`<config dir>/archive/<projectId>.json`). The
 * window builds the entries and changes the live data itself; these handlers
 * only keep the file. Each change returns the archive as it now is.
 */
export function registerArchiveHandlers(ipc: IpcRegistrar, deps: ArchiveDeps): void {
  const change = (projectId: string, fn: (archive: ProjectArchive) => ProjectArchive): ProjectArchive => {
    const next = deps.archive.update(projectId, fn)
    deps.broadcastChanged(projectId)
    return next
  }

  ipc.handle('archive-load', [safeId], (_event, projectId) => deps.archive.load(projectId))

  ipc.handle('archive-add-tasks', [safeId, v.array(archivedTaskEntry, { max: 1000 })], (_event, projectId, entries) =>
    change(projectId, archive => withArchivedTasks(archive, entries as unknown as ArchivedTask[])))

  ipc.handle('archive-add-stream', [safeId, archivedStreamEntry], (_event, projectId, entry) =>
    change(projectId, archive => withArchivedStream(archive, entry as unknown as ArchivedStream)))

  const ids = v.object({ tasks: v.optional(v.array(v.string(), { max: 1000 })), streams: v.optional(v.array(v.string(), { max: 1000 })) })

  ipc.handle('archive-remove', [safeId, ids], (_event, projectId, which) =>
    change(projectId, archive => withoutArchived(archive, which)))

  ipc.handle('archive-delete-tabs', [v.array(safeId, { max: 5000 })], (_event, tabIds) => {
    for (const tabId of tabIds) deps.deleteScrollback(tabId)
    return undefined
  })

  ipc.handle(
    'archive-transcript',
    [v.string({ nonEmpty: true, max: 64 }), v.string(), optSafeId, optSshConfig],
    (_event, sessionId, cwd, projectId, sshConfig) => deps.readTranscript(sessionId, cwd, projectId, sshConfig)
  )
}

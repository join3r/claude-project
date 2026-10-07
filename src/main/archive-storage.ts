import fs from 'fs'
import path from 'path'
import { atomicWriteFileSync, quarantine, readJsonRecord } from './storage'
import { emptyArchive, normalizeArchive, type ProjectArchive } from '../shared/archive'

/** Project ids become file names: nothing that could leave the directory. */
function isSafeId(id: string): boolean {
  return id.length > 0 && id.length <= 256 && !/[\\/\0:]/.test(id) && id !== '.' && id !== '..'
}

/**
 * `<config dir>/archive/<projectId>.json`: a project's archived tasks and
 * streams, kept out of `projects.json` so the main snapshot (and its startup
 * backups) stay small. Read only when a Done row is opened.
 *
 * Writes are atomic (temp file, fsync, rename), and every change is a
 * read-modify-write done synchronously on main's thread, so two windows
 * archiving at once can't drop each other's entries. A file that won't parse is
 * moved aside (`.corrupt-<stamp>`) rather than overwritten.
 */
export class ArchiveStorage {
  constructor(private readonly dir: string) {}

  private filePath(projectId: string): string {
    if (!isSafeId(projectId)) throw new Error(`Invalid project id for the archive: ${projectId}`)
    return path.join(this.dir, `${projectId}.json`)
  }

  load(projectId: string): ProjectArchive {
    const file = this.filePath(projectId)
    const result = readJsonRecord(file)
    if (result.kind === 'missing') return emptyArchive()
    if (result.kind === 'ok') return normalizeArchive(result.data)
    const movedTo = quarantine(file)
    console.error(`[archive] ${file} is unreadable (${String(result.error)})` + (movedTo ? `; moved to ${movedTo}` : ''))
    return emptyArchive()
  }

  /** Apply `fn` to the project's archive and write the result. An emptied archive removes its file. */
  update(projectId: string, fn: (archive: ProjectArchive) => ProjectArchive): ProjectArchive {
    const next = fn(this.load(projectId))
    const file = this.filePath(projectId)
    if (next.tasks.length === 0 && next.streams.length === 0) {
      this.delete(projectId)
      return next
    }
    fs.mkdirSync(this.dir, { recursive: true })
    atomicWriteFileSync(file, JSON.stringify(next, null, 2))
    return next
  }

  delete(projectId: string): void {
    try {
      fs.unlinkSync(this.filePath(projectId))
    } catch {
      // Never written, or already gone.
    }
  }
}

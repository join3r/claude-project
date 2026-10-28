import type { GitDiffSummary, Project } from '../shared/types'
import { taskDirectory } from '../shared/streams'
import { readTaskDiffSummary } from './ipc/git'

type ReadSummary = (cwd: string, baseBranch?: string) => Promise<GitDiffSummary | null>

/** Only a project on this machine: an SSH or server project's git runs elsewhere. */
function isLocalGitProject(project: Project): boolean {
  return !project.ssh && !project.host && !project.shellCommand && typeof project.directory === 'string' && !!project.directory
}

/**
 * Each task's lines added and removed, for the phone's inbox (SPEC.md §4.4 `diff`),
 * counted the way the sidebar Inbox counts them (`readTaskDiffSummary`): one git
 * diff per directory, every `intervalMs` while `active()` (a phone is connected).
 * Tasks with nothing changed are left out. Listeners hear only real changes.
 */
export class TaskDiffWatch {
  private byTask: ReadonlyMap<string, GitDiffSummary> = new Map()
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly projects: () => readonly Project[],
    private readonly active: () => boolean,
    private readonly intervalMs = 15_000,
    private readonly read: ReadSummary = readTaskDiffSummary
  ) {}

  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  peek(): ReadonlyMap<string, GitDiffSummary> {
    return this.byTask
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async refresh(): Promise<void> {
    if (this.running || !this.active()) return
    this.running = true
    try {
      const sources = new Map<string, { dir: string; baseBranch?: string; taskIds: string[] }>()
      for (const project of this.projects()) {
        if (!isLocalGitProject(project) || project.hideFromMobile) continue
        for (const stream of project.streams) {
          for (const task of stream.tasks) {
            const dir = taskDirectory(project, task)
            const baseBranch = task.workspace?.baseBranch
            const key = `${dir}\0${baseBranch ?? ''}`
            const source = sources.get(key) ?? { dir, baseBranch, taskIds: [] }
            source.taskIds.push(task.id)
            sources.set(key, source)
          }
        }
      }
      const results = await Promise.all([...sources.values()].map(async (source) => {
        const summary = await this.read(source.dir, source.baseBranch).catch(() => null)
        return { source, summary }
      }))
      const next = new Map<string, GitDiffSummary>()
      for (const { source, summary } of results) {
        if (!summary || (summary.added === 0 && summary.deleted === 0)) continue
        for (const taskId of source.taskIds) next.set(taskId, summary)
      }
      if (!sameSummaries(this.byTask, next)) {
        this.byTask = next
        for (const listener of [...this.listeners]) listener()
      }
    } finally {
      this.running = false
    }
  }
}

function sameSummaries(a: ReadonlyMap<string, GitDiffSummary>, b: ReadonlyMap<string, GitDiffSummary>): boolean {
  if (a.size !== b.size) return false
  for (const [taskId, summary] of a) {
    const other = b.get(taskId)
    if (!other || other.added !== summary.added || other.deleted !== summary.deleted) return false
  }
  return true
}

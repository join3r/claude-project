import { useEffect, useMemo, useState } from 'react'
import type { GitDiffSummary, Project, Task } from '../../shared/types'
import { isRemoteProject, isShellCommandProject } from '../../shared/types'
import { featureAvailable } from '../../shared/project-features'
import { taskDirectory } from '../../shared/streams'
import { pollWhileVisible } from './fileBrowserRefresh'

/** Slower than the git panel's poll: one git diff per task directory in the Inbox. */
const TASK_DIFF_REFRESH_MS = 10_000

/** Where a task's line counts come from: its directory, and the branch its own worktree came off. */
interface DiffSource {
  key: string
  dir: string
  baseBranch?: string
  projectId: string
}

/**
 * Lines added and removed per task id, for the Inbox rows. A task in its own
 * worktree counts everything since it branched off the stream; any other
 * task counts what is not committed in its directory. SSH and shell-command
 * projects, and ones `skip` says are out of reach, get nothing.
 */
export function useTaskDiffSummaries(
  tasks: ReadonlyArray<{ project: Project; task: Task }>,
  skip?: (project: Project) => boolean
): ReadonlyMap<string, GitDiffSummary> {
  const sourceOf = useMemo(() => {
    const byTask = new Map<string, DiffSource>()
    for (const { project, task } of tasks) {
      if (isRemoteProject(project) || isShellCommandProject(project) || !featureAvailable(project, 'files')) continue
      if (skip?.(project)) continue
      const dir = taskDirectory(project, task)
      if (!dir) continue
      const baseBranch = task.workspace?.baseBranch
      byTask.set(task.id, { key: `${project.id}\0${dir}\0${baseBranch ?? ''}`, dir, baseBranch, projectId: project.id })
    }
    return byTask
  }, [tasks, skip])

  // A stable identity for the set of sources, so a re-render with the same tasks keeps polling as it was.
  const sourcesKey = useMemo(() => [...new Set([...sourceOf.values()].map(s => s.key))].sort().join('\n'), [sourceOf])
  const [byKey, setByKey] = useState<ReadonlyMap<string, GitDiffSummary>>(new Map())

  useEffect(() => {
    const sources = new Map<string, DiffSource>()
    for (const source of sourceOf.values()) sources.set(source.key, source)
    if (sources.size === 0) {
      setByKey(new Map())
      return
    }
    let cancelled = false
    let inFlight = false
    const fetchAll = (): void => {
      if (inFlight) return
      inFlight = true
      void Promise.all([...sources.values()].map(async (source) => {
        try {
          const summary = await window.api.gitTaskDiffSummary(source.dir, source.baseBranch, source.projectId)
          return [source.key, summary] as const
        } catch {
          return [source.key, null] as const
        }
      })).then((results) => {
        inFlight = false
        if (cancelled) return
        const next = new Map<string, GitDiffSummary>()
        for (const [key, summary] of results) if (summary) next.set(key, summary)
        setByKey(next)
      })
    }
    fetchAll()
    const stopPolling = pollWhileVisible(fetchAll, TASK_DIFF_REFRESH_MS)
    window.addEventListener('focus', fetchAll)
    window.addEventListener('file-saved', fetchAll)
    return () => {
      cancelled = true
      stopPolling()
      window.removeEventListener('focus', fetchAll)
      window.removeEventListener('file-saved', fetchAll)
    }
    // sourcesKey stands for sourceOf's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey])

  return useMemo(() => {
    const byTask = new Map<string, GitDiffSummary>()
    for (const [taskId, source] of sourceOf) {
      const summary = byKey.get(source.key)
      if (summary) byTask.set(taskId, summary)
    }
    return byTask
  }, [sourceOf, byKey])
}

/** `1240` → `1.2k`, the way the Inbox shows line counts. */
export function formatLineCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n)
}

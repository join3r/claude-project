import { findIdleCleanupCandidates, isIdleCleanupCandidate } from '../shared/idle-cleanup'
import type {
  IdleTaskCleanupConfig,
  PinnedItem,
  Project,
  TabStatusValue,
  Task,
  WorkspaceDeleteResult
} from '../shared/types'

/** Everything the sweep is allowed to know or do, so it can be driven in a test. */
export interface IdleCleanupEnvironment {
  /**
   * Canonical projects state. Called again before every deletion rather than
   * captured once: between selecting a task and deleting it the sweep awaits a
   * backup and a workspace check, and the user is free to act in that window.
   */
  readProjects(): { projects: readonly Project[]; pinnedItems: readonly PinnedItem[] }
  /** The live config. `undefined`/disabled stops the sweep where it stands. */
  readConfig(): IdleTaskCleanupConfig | undefined
  readActivity(): {
    openTaskIds: readonly string[]
    statuses: Record<string, TabStatusValue>
    liveTabIds: readonly string[]
    dirtyTabIds: readonly string[]
  }
  now(): number
  /** Snapshot projects.json. `false` means nothing was written. */
  backupProjects(): boolean
  /** Non-force delete: it is both the clean-and-merged pre-flight and the deletion. */
  deleteWorkspace(project: Project, task: Task): Promise<WorkspaceDeleteResult>
  /** Tear the task down (PTYs, scrollback, hooks) and commit its removal. */
  removeTask(project: Project, task: Task): Promise<void> | void
  /** Drop a workspace record whose worktree is already gone but whose task survives. */
  forgetWorkspace(project: Project, task: Task): void
  log(message: string): void
}

export interface IdleCleanupSweepResult {
  deleted: Array<{ projectId: string; taskId: string }>
  /** Candidates that were passed over, with the reason — mirrored into the debug log. */
  skipped: Array<{ taskId: string; reason: string }>
  /** Set when the sweep stopped early; remaining candidates were never touched. */
  aborted: 'disabled' | 'backup-failed' | null
}

function findTask(
  env: IdleCleanupEnvironment,
  projectId: string,
  taskId: string
): { project: Project; task: Task } | null {
  const project = env.readProjects().projects.find(candidate => candidate.id === projectId)
  const task = project?.tasks.find(candidate => candidate.id === taskId)
  return project && task ? { project, task } : null
}

/**
 * The idle-task sweep, run by main.
 *
 * Two rules shape the whole thing. Every safeguard is re-evaluated against live
 * state immediately before each individual deletion (finding #8) — the settings
 * screen promises pinned/snoozed/unread/open/busy tasks are "always kept", and
 * that promise has to hold at the moment of deletion, not at selection time. And
 * nothing is deleted at all until projects.json has actually been snapshotted
 * (finding #9), because that snapshot is the only way back.
 */
export async function runIdleCleanupSweep(env: IdleCleanupEnvironment): Promise<IdleCleanupSweepResult> {
  const result: IdleCleanupSweepResult = { deleted: [], skipped: [], aborted: null }

  const config = env.readConfig()
  if (!config?.enabled) {
    result.aborted = 'disabled'
    return result
  }

  const buildInput = (cfg: IdleTaskCleanupConfig) => {
    const { projects, pinnedItems } = env.readProjects()
    const activity = env.readActivity()
    return {
      projects,
      pinnedItems,
      statuses: activity.statuses,
      openTaskIds: activity.openTaskIds,
      liveTabIds: activity.liveTabIds,
      dirtyTabIds: activity.dirtyTabIds,
      config: cfg,
      now: env.now()
    }
  }

  const candidates = findIdleCleanupCandidates(buildInput(config))
  if (candidates.length === 0) return result

  const skip = (taskId: string, reason: string): void => {
    result.skipped.push({ taskId, reason })
    env.log(`idleCleanupSkipped task=${taskId} reason=${reason}`)
  }

  // Deferred so a sweep that finds every candidate protected on the second look
  // doesn't churn the 10-slot backup ring for nothing.
  let backedUp = false
  const ensureBackup = (): boolean => {
    if (backedUp) return true
    backedUp = env.backupProjects()
    return backedUp
  }

  for (const candidate of candidates) {
    // Turning cleanup off mid-sweep has to stop the deletions that have not happened yet.
    const liveConfig = env.readConfig()
    if (!liveConfig?.enabled) {
      result.aborted = 'disabled'
      env.log('idleCleanupAborted reason=disabled-mid-sweep')
      return result
    }

    const found = findTask(env, candidate.projectId, candidate.taskId)
    if (!found) {
      skip(candidate.taskId, 'gone')
      continue
    }
    if (!isIdleCleanupCandidate(buildInput(liveConfig), candidate.projectId, candidate.taskId)) {
      skip(candidate.taskId, 'no-longer-eligible')
      continue
    }
    // The workspace on record may not be the one selected — a task can be pointed
    // at a different worktree while the sweep runs.
    if (candidate.workspace && !found.task.workspace) {
      skip(candidate.taskId, 'workspace-changed')
      continue
    }

    if (!ensureBackup()) {
      result.aborted = 'backup-failed'
      env.log('idleCleanupAborted reason=backup-failed')
      return result
    }

    if (found.task.workspace) {
      let deleteResult: WorkspaceDeleteResult
      try {
        deleteResult = await env.deleteWorkspace(found.project, found.task)
      } catch (err) {
        skip(candidate.taskId, `workspace-error:${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      // Anything but 'ok' means the worktree still holds something (or could not be
      // checked at all), and main deliberately left it alone.
      if (deleteResult.status !== 'ok') {
        skip(candidate.taskId, `workspace-${deleteResult.status}`)
        continue
      }

      // The worktree is gone now. If a safeguard came up during that await we keep
      // the task — but its workspace record points at nothing, so it has to go.
      const stillThere = findTask(env, candidate.projectId, candidate.taskId)
      if (!stillThere) {
        skip(candidate.taskId, 'gone')
        continue
      }
      if (!isIdleCleanupCandidate(buildInput(env.readConfig() ?? liveConfig), candidate.projectId, candidate.taskId)) {
        env.forgetWorkspace(stillThere.project, stillThere.task)
        skip(candidate.taskId, 'no-longer-eligible-after-workspace-delete')
        continue
      }
    }

    const doomed = findTask(env, candidate.projectId, candidate.taskId)
    if (!doomed) {
      skip(candidate.taskId, 'gone')
      continue
    }
    await env.removeTask(doomed.project, doomed.task)
    result.deleted.push({ projectId: candidate.projectId, taskId: candidate.taskId })
    env.log(`idleCleanupDeleted project=${candidate.projectId} task=${candidate.taskId}`)
  }

  return result
}

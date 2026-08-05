import type { IdleTaskCleanupConfig, PinnedItem, Project, TabStatusValue, Task } from './types'
import { isHomeTask, pinnedItemKey } from './types'
import { isSettled, isSnoozed, isUnread, lastActivityAt, taskStatus } from './inbox-state'

const DAY_MS = 86_400_000

export interface IdleCleanupInput {
  projects: readonly Project[]
  pinnedItems: readonly PinnedItem[]
  /** Per-tab statuses. In main this is the activity registry, in the settings preview the window's store. */
  statuses: Record<string, TabStatusValue>
  /** Tasks selected in any open window. */
  openTaskIds: readonly string[]
  /**
   * Tabs whose process is still alive in main. A hidden AI tab keeps its PTY
   * running with no window showing it as working, which is exactly the agent
   * finding #7 was deleting out from under the user.
   */
  liveTabIds?: readonly string[]
  /**
   * Tabs holding an unsaved editor buffer, in any window. Nobody is standing in
   * front of the Save/Discard dialog during a background sweep, so an unsaved
   * buffer is a safeguard rather than a prompt.
   */
  dirtyTabIds?: readonly string[]
  config: IdleTaskCleanupConfig
  now: number
}

export interface IdleCleanupCandidate {
  projectId: string
  projectName: string
  taskId: string
  taskName: string
  /** Still needs a clean-and-merged pre-flight before it may actually be deleted. */
  workspace: boolean
  lastActivityAt: number
}

/**
 * Tasks the sweep would delete, evaluated per project.
 *
 * Deliberately ignores `config.enabled` so the settings preview can show what the knobs
 * would do before the master switch is flipped — the sweep itself checks it.
 *
 * Workspace candidates are only ever returned when `includeCleanWorkspaces` is set, and
 * even then the caller must confirm the worktree is clean and the branch merged.
 */
export function findIdleCleanupCandidates(input: IdleCleanupInput): IdleCleanupCandidate[] {
  const { projects, pinnedItems, statuses, openTaskIds, config, now } = input

  const ageOn = config.byAge?.enabled ?? false
  const countOn = config.byCount?.enabled ?? false
  if (!ageOn && !countOn) return []

  const pinnedKeys = new Set(pinnedItems.map(pinnedItemKey))
  const openIds = new Set(openTaskIds)
  const liveTabIds = new Set(input.liveTabIds ?? [])
  const dirtyTabIds = new Set(input.dirtyTabIds ?? [])
  const maxTasks = Math.max(1, config.byCount?.maxTasks ?? 20)
  const staleAfterMs = Math.max(1, config.byAge?.days ?? 14) * DAY_MS

  const candidates: IdleCleanupCandidate[] = []

  for (const project of projects) {
    // Exempt tasks still occupy a slot: the cap means "at most N tasks in this project",
    // which is what the sidebar actually shows.
    const pool = (project.tasks ?? [])
      .filter(task => !isHomeTask(task))
      .sort((a, b) => lastActivityAt(b) - lastActivityAt(a))

    pool.forEach((task, index) => {
      const overCap = countOn && index >= maxTasks
      const stale = ageOn && now - lastActivityAt(task) >= staleAfterMs

      const flagged = config.combine === 'or'
        ? (ageOn && stale) || (countOn && overCap)
        : (!ageOn || stale) && (!countOn || overCap)
      if (!flagged) return

      if (isProtected(task, { project, pinnedKeys, openIds, liveTabIds, dirtyTabIds, statuses, config, now })) return

      candidates.push({
        projectId: project.id,
        projectName: project.name,
        taskId: task.id,
        taskName: task.name,
        workspace: !!task.workspace,
        lastActivityAt: lastActivityAt(task)
      })
    })
  }

  return candidates
}

/**
 * Whether a task selected earlier in the sweep still qualifies *right now*.
 *
 * The sweep awaits a backup and a workspace check between choosing a task and
 * deleting it, and everything the safeguards look at can change inside that
 * window (finding #8). Recomputing the whole candidate set is what keeps this
 * honest: one predicate, no second copy of the rules to drift.
 */
export function isIdleCleanupCandidate(input: IdleCleanupInput, projectId: string, taskId: string): boolean {
  return findIdleCleanupCandidates(input)
    .some(candidate => candidate.projectId === projectId && candidate.taskId === taskId)
}

interface ProtectionContext {
  project: Project
  pinnedKeys: Set<string>
  openIds: Set<string>
  liveTabIds: Set<string>
  dirtyTabIds: Set<string>
  statuses: Record<string, TabStatusValue>
  config: IdleTaskCleanupConfig
  now: number
}

function isProtected(task: Task, ctx: ProtectionContext): boolean {
  const { project, pinnedKeys, openIds, liveTabIds, dirtyTabIds, statuses, config, now } = ctx

  // Hard invariant, not a setting: you can never lose something you were never shown.
  if (isUnread(task)) return true
  // An explicit "wake me later" must outlive the janitor, or snoozing would be a trap.
  if (isSnoozed(task, now)) return true
  if (pinnedKeys.has(pinnedItemKey({ type: 'task', projectId: project.id, taskId: task.id }))) return true
  if (openIds.has(task.id)) return true

  const tabIds = [...task.tabs.left, ...task.tabs.right].map(tab => tab.id)
  // A running process is the ground truth the status dots are only a view of: a
  // non-hook tool (Codex) reports 'attention' through renderer-only heuristics
  // main never sees, and a hidden hook tab keeps its PTY without any window
  // showing it. Either way, nothing with a live process gets deleted.
  if (tabIds.some(tabId => liveTabIds.has(tabId))) return true
  // No dialog can be answered during a background sweep, so an unsaved buffer
  // means "not now" rather than "discard it".
  if (tabIds.some(tabId => dirtyTabIds.has(tabId))) return true

  // An agent is mid-run or blocked on you right now, whatever the timestamps say.
  const status = taskStatus(task, statuses)
  if (status === 'working' || status === 'attention') return true

  if (config.settledOnly && !isSettled(task)) return true
  if (task.workspace && !config.includeCleanWorkspaces) return true

  return false
}

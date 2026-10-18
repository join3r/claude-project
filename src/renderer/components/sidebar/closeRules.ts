/**
 * When closing a task or a stream asks first, and what it asks. Pure, so the
 * rules are testable without the sidebar:
 *
 * - A task asks only when its agent is working (unsaved editors get the usual
 *   Save/Discard dialog from `confirmDiscardDirty`).
 * - A stream asks when any of its tasks is working, and runs the worktree
 *   pre-flight: no uncommitted or unmerged work removes the worktree and branch
 *   without a word; anything else asks keep branch / discard / cancel.
 * - `main` can't be closed, only emptied.
 * - A task with a worktree of its own lands into its stream when it closes
 *   (`taskLandingCloseQuestion`): it asks Land & close / Keep branch / Discard,
 *   saying what landing would take, and asks nothing when there is nothing to
 *   land. A task sharing its stream's worktree (from before task worktrees) and
 *   a `main` task close as above.
 * - A stream whose tasks have worktrees of their own asks once about all of
 *   them (`streamTasksCloseQuestion`): Land all / Keep branches / Discard all,
 *   listing the tasks with work not landed. Its own worktree's pre-flight
 *   comes after.
 */
import { isAgentTabType } from '../../../shared/types'
import type { Stream, TabStatusValue, Task, TaskLandingPreview, WorkspaceConfig, WorkspaceDeleteResult } from '../../../shared/types'
import { taskTabs } from '../../../shared/streams'
import { plural } from '../../../shared/task-close-question'

// Shared with main, which puts the same question to a phone (`task.close` with `ask`).
export { landingSummary, taskLandingCloseQuestion, type TaskLandingCloseQuestion } from '../../../shared/task-close-question'

export type StatusOf = (tabId: string) => TabStatusValue | undefined

/** An agent tab of the task is mid-turn. */
export function isTaskWorking(task: Task, statusOf: StatusOf): boolean {
  return taskTabs(task).some(tab => isAgentTabType(tab.type) && statusOf(tab.id) === 'working')
}

/** The question before closing a task, or null to close it straight away. */
export function taskCloseQuestion(task: Task, statusOf: StatusOf): string | null {
  if (!isTaskWorking(task, statusOf)) return null
  return `"${task.name}" is still working.\n\nClose it anyway? Its agent stops and its tabs close.`
}

/** The confirm before removing a task with a worktree of its own: nothing of it lands. */
export function taskRemoveQuestion(task: Task): string {
  const branch = task.workspace?.branchName
  return `Do you really want to remove "${task.name}" and all its changes?\n\n`
    + `Its worktree${branch ? ` and branch "${branch}"` : ''} are deleted, uncommitted work with them. Nothing is landed.`
}

/** The question before closing a stream's tasks, or null when none is working. */
export function streamCloseQuestion(stream: Stream, statusOf: StatusOf): string | null {
  if (stream.isMain) return null
  const working = stream.tasks.filter(task => isTaskWorking(task, statusOf))
  if (working.length === 0) return null
  const names = working.map(task => `"${task.name}"`).join(', ')
  const verb = working.length === 1 ? 'is' : 'are'
  return `${names} ${verb} still working.\n\nClose stream "${stream.name}" anyway? Its agents stop and its tabs close.`
}

/** What the pre-flight (a non-forced `workspaceDelete`) leaves to do. */
export type WorktreePreflight =
  /** Clean and merged: the pre-flight already removed the worktree and branch. */
  | { kind: 'removed' }
  /** Not a registered worktree: the forced pass reports it, nothing to ask. */
  | { kind: 'force' }
  /** Work would be lost: ask keep branch / discard / cancel. */
  | { kind: 'ask'; message: string }

export function worktreePreflight(result: WorkspaceDeleteResult, workspace: WorkspaceConfig): WorktreePreflight {
  const branch = `"${workspace.branchName}"`
  const base = `"${result.baseBranch ?? workspace.baseBranch}"`
  switch (result.status) {
    case 'ok':
      return { kind: 'removed' }
    case 'invalid-worktree':
      return { kind: 'force' }
    case 'uncommitted':
      return { kind: 'ask', message: `The worktree has uncommitted changes. They are lost either way; keeping the branch keeps its commits.` }
    case 'unmerged':
      return { kind: 'ask', message: `Branch ${branch} has commits not merged into ${base}.` }
    case 'uncommitted-and-unmerged':
      return { kind: 'ask', message: `The worktree has uncommitted changes, and branch ${branch} has commits not merged into ${base}. The uncommitted changes are lost either way.` }
    case 'check-failed':
      return { kind: 'ask', message: `DevTool could not check the worktree for unsaved work${result.reason ? ` (${result.reason})` : ''}. Uncommitted or unmerged work may be lost.` }
  }
}

export type WorktreeChoice = 'keep-branch' | 'discard' | 'cancel'

/** The forced removal a choice asks for, or null for cancel. */
export function worktreeRemovalFor(choice: WorktreeChoice): { keepBranch: boolean } | null {
  if (choice === 'cancel') return null
  return { keepBranch: choice === 'keep-branch' }
}


/**
 * Why the task menu's Land / Update from stream can't run now, or null. A
 * landing already running or stopped is the task's banner's to finish.
 */
export function landingActionBlocker(task: Task, statusOf: StatusOf, busy: boolean): string | null {
  if (isTaskWorking(task, statusOf)) return 'agent working'
  if (busy || task.landing?.state === 'landing') return 'landing…'
  if (task.landing?.state === 'fixing') return 'agent fixing'
  if (task.landing) return 'landing stopped'
  return null
}

/** One task the stream-close question lists, and what it holds. */
export interface StreamTaskWork {
  taskId: string
  name: string
  /** "2 commits, uncommitted changes in 1 file". */
  holds: string
}

export interface StreamTasksCloseQuestion {
  title: string
  streamName: string
  /** In the stream's order, which is the order Land all lands them in. */
  tasks: StreamTaskWork[]
  /** Null when Land all is on offer; otherwise why not. */
  landBlocked: string | null
}

/** A task with a worktree of its own, as the stream's close found it. */
export interface StreamTaskCheck {
  task: Task
  /** Null when main couldn't tell. */
  preview: TaskLandingPreview | null
  working: boolean
}

/** Whether closing would lose (or land) something of the task's. */
export function taskHasWork(check: StreamTaskCheck): boolean {
  const { preview, task, working } = check
  return working || !!task.landing || !preview || preview.commits > 0 || preview.uncommitted > 0
}

function taskHolds(check: StreamTaskCheck): string {
  const { preview, task, working } = check
  const parts: string[] = []
  if (preview?.commits) parts.push(plural(preview.commits, 'commit'))
  if (preview?.uncommitted) parts.push(`uncommitted changes in ${plural(preview.uncommitted, 'file')}`)
  if (!preview && !task.landing) parts.push('work DevTool could not check')
  if (task.landing?.state === 'conflict' || task.landing?.state === 'fixing') parts.push('a landing stopped on conflicts')
  else if (task.landing?.state === 'blocked') parts.push('a landing blocked by local changes in the stream')
  else if (task.landing?.state === 'landing') parts.push('a landing under way')
  if (working) parts.push('its agent is working')
  return parts.join(', ')
}

/**
 * The question before closing a stream whose tasks have worktrees of their
 * own, or null when none of them has anything to land (their worktrees just
 * go). Land all is held back while an agent works or a landing stands.
 */
export function streamTasksCloseQuestion(stream: Stream, checks: readonly StreamTaskCheck[]): StreamTasksCloseQuestion | null {
  const withWork = checks.filter(taskHasWork)
  if (withWork.length === 0) return null
  const working = withWork.find(check => check.working)
  // A blocked landing is just tried again; a conflict has to be settled in the task.
  const stopped = withWork.find(check => check.task.landing && check.task.landing.state !== 'blocked')
  const landBlocked = working
    ? `"${working.task.name}" is still working`
    : stopped
      ? `Finish or abort the landing of "${stopped.task.name}" first`
      : null
  return {
    title: `Close stream "${stream.name}"?`,
    streamName: stream.name,
    tasks: withWork.map(check => ({ taskId: check.task.id, name: check.task.name, holds: taskHolds(check) })),
    landBlocked
  }
}

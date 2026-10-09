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
 */
import { isAgentTabType } from '../../../shared/types'
import type { Stream, TabStatusValue, Task, TaskLandingPreview, WorkspaceConfig, WorkspaceDeleteResult } from '../../../shared/types'
import { taskTabs } from '../../../shared/streams'

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

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "Squash 3 commits and uncommitted changes in 2 files into 0.5.0." */
export function landingSummary(preview: TaskLandingPreview, streamName: string): string {
  const { commits, uncommitted } = preview
  const changes = `uncommitted changes in ${plural(uncommitted, 'file')}`
  if (commits === 0) return `Commit ${changes} into ${streamName}.`
  return `Squash ${plural(commits, 'commit')}${uncommitted > 0 ? ` and ${changes}` : ''} into ${streamName}.`
}

export interface TaskLandingCloseQuestion {
  title: string
  /** What landing would do, or why the task can't land right now. */
  message: string
  /** The task's branch, which Keep branch leaves in the repository. */
  branch: string
  /** Null when Land & close is on offer; otherwise why not. */
  landBlocked: string | null
}

/**
 * The question before closing a task that has a worktree of its own, or null
 * to land it straight away (nothing to land: the worktree and branch just go).
 * `preview` is null when main couldn't tell what landing would take.
 */
export function taskLandingCloseQuestion(
  task: Task,
  streamName: string,
  preview: TaskLandingPreview | null,
  working: boolean
): TaskLandingCloseQuestion | null {
  const base = { title: `Close task "${task.name}"?`, branch: task.workspace?.branchName ?? '' }
  const landing = task.landing
  if (landing?.state === 'conflict' || landing?.state === 'fixing') {
    const files = landing.files?.length ? ` in ${plural(landing.files.length, 'file')}` : ''
    const what = landing.intent === 'update' ? `Updating from ${streamName}` : `Landing into ${streamName}`
    return {
      ...base,
      message: `${what} stopped on conflicts${files}. Resolve them in the task to land it, or close it without landing.`,
      landBlocked: 'Resolve the conflicts first'
    }
  }
  if (working) {
    return {
      ...base,
      message: `"${task.name}" is still working. Let it finish to land its work into ${streamName}, or close it without landing: its agent stops and its tabs close.`,
      landBlocked: 'Its agent is working'
    }
  }
  if (landing?.state === 'blocked') {
    const where = landing.files?.length ? ` in ${landing.files.join(', ')}` : ''
    return { ...base, message: `${streamName} has local changes${where}, so the last landing stopped. Land & close tries again.`, landBlocked: null }
  }
  if (!preview) return { ...base, message: `Land the task's work into ${streamName}, squashed into one commit.`, landBlocked: null }
  if (preview.commits === 0 && preview.uncommitted === 0) return null
  return { ...base, message: landingSummary(preview, streamName), landBlocked: null }
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

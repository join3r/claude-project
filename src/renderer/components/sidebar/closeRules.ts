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
 */
import { isAgentTabType } from '../../../shared/types'
import type { Stream, TabStatusValue, Task, WorkspaceConfig, WorkspaceDeleteResult } from '../../../shared/types'
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

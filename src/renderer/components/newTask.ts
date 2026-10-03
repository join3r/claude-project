/**
 * Helpers for the "New task" composer. Task names are free-form prose ("fix the
 * inbox badge count"), but a workspace turns that name into a git branch, and git
 * rejects most of what reads naturally. These keep the two apart: you name the
 * task like a subject line, the branch is derived and stays editable.
 */

import { fuzzyMatch } from '../palette/fuzzy'
import { branchSlug, defaultBaseBranch } from '../../shared/branch-name'

export { branchSlug, defaultBaseBranch }

/**
 * Where a composed task will land. A `dir` target is a directory the user picked
 * that no project owns yet — nothing is written until the task is actually
 * created, so cancelling the composer leaves no trace.
 */
export type NewTaskTarget =
  | { kind: 'project'; projectId: string }
  | { kind: 'dir'; directory: string }

export interface NewTaskDraft {
  target: NewTaskTarget | null
  name: string
  /** Whether the task should get its own worktree + branch. */
  workspace: boolean
  branch: string
  baseBranch: string
}

/**
 * A draft is submittable once it has somewhere to go. The name is optional: an
 * unnamed task opens on its prompt box and the first prompt names it. A workspace
 * task also needs a branch to create it from, and a branch to create unless it is
 * left pending (no name, no branch).
 */
export function isNewTaskDraftValid(draft: NewTaskDraft): boolean {
  if (!draft.target) return false
  if (draft.target.kind === 'project' ? !draft.target.projectId : !draft.target.directory) return false
  if (!draft.workspace) return true
  if (!draft.baseBranch) return false
  return draft.branch.trim().length > 0 || isPendingWorkspaceDraft(draft)
}

/**
 * A workspace asked for with neither a task name nor a branch: the task opens on
 * its prompt box and the worktree is created once the first prompt names it.
 */
export function isPendingWorkspaceDraft(draft: NewTaskDraft): boolean {
  return draft.workspace && !draft.name.trim() && !draft.branch.trim()
}

/**
 * Orders projects for the composer's picker, using the same scorer as the command
 * palette so "dvt" finds "devtool" here exactly as it does under Cmd+P. Unlike the
 * palette this keeps every subsequence hit rather than applying a score floor: the
 * list is short and already on screen, so a one-letter filter should narrow it, not
 * blank it. An empty filter keeps the caller's order — the picker doubles as the
 * plain list you scroll to find the project you already have selected.
 */
export function matchProjects<T extends { name: string }>(projects: readonly T[], filter: string): T[] {
  const query = filter.trim()
  if (!query) return [...projects]
  return projects
    .map(p => ({ p, score: fuzzyMatch(query, p.name)?.score ?? -1 }))
    .filter(s => s.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.p)
}

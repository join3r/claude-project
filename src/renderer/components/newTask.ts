/**
 * Helpers for the "New task" composer: pick where the task goes, type its first
 * prompt, send. The prompt names the task and, for a workspace, its branch.
 */

import { fuzzyMatch } from '../palette/fuzzy'
import type { PromptBoxAgent, WorkspaceConfig, WorkspaceDraft } from '../../shared/types'
import type { PendingPrompt } from './promptBox'
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

/** What the composer asks for: a task, maybe an agent started on it, maybe a worktree. */
export interface NewTaskSubmission {
  target: NewTaskTarget
  /** The agent tab to open with the first prompt; absent, the task opens on its prompt box. */
  start?: { agent: PromptBoxAgent; prompt: PendingPrompt }
  /** A worktree already cut for the task. */
  workspace?: WorkspaceConfig
  /** A workspace still to be cut, when the first prompt names it. */
  workspaceDraft?: WorkspaceDraft
}

export interface NewTaskDraft {
  target: NewTaskTarget | null
  /** The first prompt. It names the task, and the branch when there is a workspace. */
  prompt: string
  /** Whether the task should get its own worktree + branch. */
  workspace: boolean
  baseBranch: string
}

/**
 * A draft is submittable once it has somewhere to go. The prompt is optional: a
 * task created without one opens on its prompt box. A workspace also needs a
 * branch to fork from.
 */
export function isNewTaskDraftValid(draft: NewTaskDraft): boolean {
  if (!draft.target) return false
  if (draft.target.kind === 'project' ? !draft.target.projectId : !draft.target.directory) return false
  return !draft.workspace || !!draft.baseBranch
}

/**
 * A workspace asked for without a prompt: nothing to name the branch after yet,
 * so the task opens on its prompt box and the worktree is cut on the first send.
 */
export function isPendingWorkspaceDraft(draft: NewTaskDraft): boolean {
  return draft.workspace && !draft.prompt.trim()
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

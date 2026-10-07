/**
 * Helpers for the "New task" composer: pick where the task goes (project and
 * stream), say whether it is an agent or a terminal, type its first prompt (or
 * start-up command), send. The prompt or command names the task.
 */

import { fuzzyMatch } from '../palette/fuzzy'
import type { PromptBoxAgent } from '../../shared/types'
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

/** An agent task, or a terminal task. */
export type NewTaskKind = 'agent' | 'terminal'

/** What the composer asks for: a task in a stream, maybe an agent or a terminal started on it. */
export interface NewTaskSubmission {
  target: NewTaskTarget
  /** The stream of a project target; absent means `main`. */
  streamId?: string
  /** The agent tab to open with the first prompt; absent, the task opens on its prompt box. */
  start?: { agent: PromptBoxAgent; prompt: PendingPrompt }
  /** A terminal task, with the command to type into it once it starts (if any). */
  terminal?: { command?: string }
}

export interface NewTaskDraft {
  target: NewTaskTarget | null
  /** The first prompt or start-up command. It names the task. */
  prompt: string
}

/** A draft is submittable once it has somewhere to go; the prompt is optional. */
export function isNewTaskDraftValid(draft: NewTaskDraft): boolean {
  if (!draft.target) return false
  return draft.target.kind === 'project' ? !!draft.target.projectId : !!draft.target.directory
}

/** A terminal task's name: its start-up command when it has one, else "Terminal". */
export function terminalTaskName(command: string | undefined): string {
  const firstLine = (command ?? '').trim().split('\n')[0].trim()
  if (!firstLine) return TERMINAL_TASK_NAME
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine
}

export const TERMINAL_TASK_NAME = 'Terminal'

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

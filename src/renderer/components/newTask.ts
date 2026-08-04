/**
 * Helpers for the "New task" composer. Task names are free-form prose ("fix the
 * inbox badge count"), but a workspace turns that name into a git branch, and git
 * rejects most of what reads naturally. These keep the two apart: you name the
 * task like a subject line, the branch is derived and stays editable.
 */

import { fuzzyMatch } from '../palette/fuzzy'

/**
 * Git-safe branch name derived from a free-form task name. Mirrors the rules
 * `git check-ref-format --branch` enforces, so the composer can offer a name that
 * won't be rejected by the time it reaches the worktree call.
 */
export function branchSlug(taskName: string): string {
  let slug = taskName
    .trim()
    .toLowerCase()
    // Everything git tolerates in a branch name; the rest becomes a separator.
    .replace(/[^a-z0-9._/-]+/g, '-')
    // ".." and "@{" are rejected outright, and a leading dot on any path segment
    // makes it a hidden ref.
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-._/]+/, '')
    .replace(/[-._/]+$/, '')

  // A branch may not end in ".lock" — strip it rather than fail at create time.
  while (slug.endsWith('.lock')) {
    slug = slug.slice(0, -'.lock'.length).replace(/[-._/]+$/, '')
  }

  return slug
}

export interface NewTaskDraft {
  projectId: string
  name: string
  /** Whether the task should get its own worktree + branch. */
  workspace: boolean
  branch: string
  baseBranch: string
}

/**
 * A draft is submittable when it names a task, and — for a workspace task — has
 * both a branch to create and a branch to create it from.
 */
export function isNewTaskDraftValid(draft: NewTaskDraft): boolean {
  if (!draft.projectId) return false
  if (!draft.name.trim()) return false
  if (!draft.workspace) return true
  return draft.branch.trim().length > 0 && draft.baseBranch.length > 0
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

/** Picks the branch a workspace should fork from: main, then master, then whatever exists. */
export function defaultBaseBranch(branches: readonly string[]): string {
  return branches.find(b => b === 'main') ?? branches.find(b => b === 'master') ?? branches[0] ?? ''
}

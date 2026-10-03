/**
 * Branch names for workspace tasks, shared by the renderer's composer and prompt
 * box and by main's `task.new` for the phone (SPEC.md §8.6).
 */

import { taskNameFromPrompt } from './task-name'

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

/** Picks the branch a workspace should fork from: main, then master, then whatever exists. */
export function defaultBaseBranch(branches: readonly string[]): string {
  return branches.find(b => b === 'main') ?? branches.find(b => b === 'master') ?? branches[0] ?? ''
}

const BRANCH_MAX = 40

/**
 * The branch a pending workspace task gets, from its first prompt (or, when a
 * terminal or browser opens first, its name). Cut at a word boundary to stay
 * readable, `task` when nothing git-safe is left, and suffixed `-2`, `-3`… past
 * branches that already exist.
 */
export function workspaceBranchName(source: string, existing: readonly string[]): string {
  let slug = branchSlug(taskNameFromPrompt(source, 200).replace(/…$/, ''))
  if (slug.length > BRANCH_MAX) {
    const cut = slug.slice(0, BRANCH_MAX)
    // A cut that lands right before a separator already ends on a whole word.
    const boundary = slug[BRANCH_MAX] === '-' ? BRANCH_MAX : cut.lastIndexOf('-')
    slug = (boundary > BRANCH_MAX / 2 ? cut.slice(0, boundary) : cut).replace(/[-._/]+$/, '')
  }
  if (!slug) slug = 'task'
  const taken = new Set(existing)
  if (!taken.has(slug)) return slug
  let n = 2
  while (taken.has(`${slug}-${n}`)) n += 1
  return `${slug}-${n}`
}

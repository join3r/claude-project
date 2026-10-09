import { NEW_TASK_NAME } from './types'

/**
 * Branch names for worktree streams (the New stream dialog) and task worktrees.
 */

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

/** Longest task part of a task branch; prompts make long task names. */
const TASK_SLUG_MAX = 40

/**
 * The branch for a task's own worktree: `<streamBranch>--<slug>`. Not
 * `<stream>/<slug>`: git can't hold both `refs/heads/x` and `refs/heads/x/y`.
 * An unnamed task (empty or the "New Task" placeholder) is `task`. When the
 * name is taken, `-2`, `-3`… is appended. `existing` is every branch name in
 * the repo; the comparison ignores case (refs are files on macOS/Windows).
 */
export function taskBranchName(streamBranch: string, taskName: string, existing: readonly string[]): string {
  const named = taskName.trim() && taskName.trim().toLowerCase() !== NEW_TASK_NAME.toLowerCase()
  const slug = named
    // Again after the cut, which can leave a trailing separator or `.lock`.
    ? branchSlug(branchSlug(taskName.replace(/\//g, '-')).slice(0, TASK_SLUG_MAX))
    : ''
  const base = `${streamBranch}--${slug || 'task'}`
  const taken = existing.map(name => name.toLowerCase())
  const isTaken = (candidate: string) => {
    const lower = candidate.toLowerCase()
    return taken.some(name => name === lower || name.startsWith(`${lower}/`))
  }
  if (!isTaken(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!isTaken(candidate)) return candidate
  }
}

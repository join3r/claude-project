/**
 * Branch names for worktree streams (the New stream dialog).
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

/**
 * Helpers for the New stream dialog: the name it suggests, and the branch a
 * worktree stream starts with.
 */
import type { Project } from '../../shared/types'
import { branchSlug } from '../../shared/branch-name'

const VERSION = /^(v?)(\d+)\.(\d+)(?:\.(\d+))?$/

/**
 * The next versions after `name` when it reads as one: `0.4.2` → next `0.4.3`,
 * minor `0.5.0`; `0.4` → next `0.5`, minor `1.0`. A `v` prefix is kept. Null
 * for anything else.
 */
export function nextVersions(name: string): { next: string; minor: string } | null {
  const match = VERSION.exec(name.trim())
  if (!match) return null
  const [, v, majorText, minorText, patchText] = match
  const major = Number(majorText)
  const minor = Number(minorText)
  if (patchText === undefined) {
    return { next: `${v}${major}.${minor + 1}`, minor: `${v}${major + 1}.0` }
  }
  return { next: `${v}${major}.${minor}.${Number(patchText) + 1}`, minor: `${v}${major}.${minor + 1}.0` }
}

/**
 * What the dialog suggests: the next version after the project's last stream
 * (the most recently added one other than `main`) when its name looks like a
 * version, else nothing.
 */
export function suggestStreamName(project: Project): { name: string; minor?: string } {
  const last = [...project.streams].reverse().find(stream => !stream.isMain)
  const versions = last ? nextVersions(last.name) : null
  return versions ? { name: versions.next, minor: versions.minor } : { name: '' }
}

/** The branch a worktree stream named `name` starts with (editable in the dialog). */
export function defaultStreamBranch(name: string): string {
  return branchSlug(name)
}

/** Whether a stream may offer a worktree: not for a shell-command project. */
export function streamWorktreeSupported(project: Project): boolean {
  return !project.shellCommand
}

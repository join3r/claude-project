import type { GitFileStatus, GitStatusEntry } from '../shared/types'

/**
 * Machine-readable, NUL-delimited status. `-z` output is never C-quoted, so
 * paths arrive as exact raw bytes — the default (newline) porcelain format
 * quotes anything with spaces, non-ASCII bytes, backslashes or control
 * characters, and those quoted strings are not valid pathspecs.
 */
export const GIT_STATUS_ARGS = ['status', '--porcelain=v1', '-z']

export interface ParsedGitStatus {
  staged: GitStatusEntry[]
  unstaged: GitStatusEntry[]
  untracked: GitStatusEntry[]
}

/** Rename/copy records carry a second path field (the original path). */
function hasOriginalPath(indexStatus: string, workTreeStatus: string): boolean {
  return indexStatus === 'R' || indexStatus === 'C'
    || workTreeStatus === 'R' || workTreeStatus === 'C'
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * Record grammar (fields are NUL-separated, every record NUL-terminated):
 *
 *   XY SP <path> NUL                  ordinary entry
 *   XY SP <path> NUL <origPath> NUL   rename/copy entry (X or Y is R or C)
 *
 * X is the index (staged) column and Y the worktree column; for rename/copy
 * entries `<path>` is the new path and `<origPath>` the path it came from.
 */
export function parseGitStatusZ(stdout: string): ParsedGitStatus {
  const staged: GitStatusEntry[] = []
  const unstaged: GitStatusEntry[] = []
  const untracked: GitStatusEntry[] = []

  const fields = stdout.split('\0')

  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i]
    // A record is at least "XY " plus a one-character path; the split leaves a
    // trailing empty field after the final NUL.
    if (!record || record.length < 4) continue

    const indexStatus = record[0]
    const workTreeStatus = record[1]
    const filePath = record.slice(3)

    let origPath: string | undefined
    if (hasOriginalPath(indexStatus, workTreeStatus)) {
      const next = fields[i + 1]
      if (next) {
        origPath = next
        i += 1
      }
    }

    if (indexStatus === '?' && workTreeStatus === '?') {
      untracked.push({ relativePath: filePath, status: '?' })
      continue
    }

    if (indexStatus !== ' ' && indexStatus !== '?') {
      staged.push({
        relativePath: filePath,
        status: indexStatus as GitFileStatus,
        ...(origPath ? { origPath } : {})
      })
    }
    if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
      unstaged.push({
        relativePath: filePath,
        status: workTreeStatus as GitFileStatus,
        ...(origPath && (workTreeStatus === 'R' || workTreeStatus === 'C') ? { origPath } : {})
      })
    }
  }

  return { staged, unstaged, untracked }
}

import type { GitDiffSummary } from '../shared/types'

export function parseNumstat(stdout: string): GitDiffSummary {
  const summary: GitDiffSummary = { added: 0, deleted: 0 }

  for (const line of stdout.split('\n')) {
    if (!line) continue
    const [addedText, deletedText] = line.split('\t')
    const added = Number.parseInt(addedText, 10)
    const deleted = Number.parseInt(deletedText, 10)

    if (Number.isFinite(added)) {
      summary.added += added
    }
    if (Number.isFinite(deleted)) {
      summary.deleted += deleted
    }
  }

  return summary
}

/** Files in git numstat output: one line each, binary files and renames included. */
export function countNumstatFiles(stdout: string): number {
  return stdout.split('\n').filter(line => line.includes('\t')).length
}

/** Paths in NUL-separated output (`git ls-files -z`). */
export function countNulPaths(stdout: string): number {
  return stdout.split('\0').filter(Boolean).length
}

export function countTextLines(content: string): number {
  if (!content) return 0

  const lines = content.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.length
}

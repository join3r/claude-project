import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitBranchGraph, GitGraphCommit } from '../shared/types'

const execFileAsync = promisify(execFile)

export const EMPTY_BRANCH_GRAPH: GitBranchGraph = { commits: [], tips: {}, head: null, more: false }

const FIELD = '\x1f'
const RECORD = '\x1e'
export const GRAPH_LOG_FORMAT = ['%H', '%P', '%an', '%cI', '%s'].join('%x1f') + '%x1e'

/** `git log --format=GRAPH_LOG_FORMAT` → commits. */
export function parseGraphLog(stdout: string): GitGraphCommit[] {
  return stdout.split(RECORD)
    .map(entry => entry.replace(/^\n/, ''))
    .filter(Boolean)
    .map(entry => {
      const [hash, parents = '', author = '', isoDate = '', subject = ''] = entry.split(FIELD)
      return { hash, parents: parents.split(' ').filter(Boolean), author, isoDate, subject }
    })
}

/**
 * The graph of `branches` plus the checked-out branch of `cwd`, newest first,
 * at most `limit` commits. Names that aren't local branches are dropped, so a
 * renderer can't hand git an option or an arbitrary revision.
 */
export async function readBranchGraph(cwd: string, branches: readonly string[], limit: number): Promise<GitBranchGraph> {
  const git = async (args: string[]): Promise<string> =>
    (await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout
  let head: string | null = null
  try {
    head = (await git(['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null
  } catch { /* detached */ }
  const local = new Map<string, string>()
  for (const line of (await git(['for-each-ref', '--format=%(refname:short)%00%(objectname)', 'refs/heads'])).split('\n')) {
    const [name, sha] = line.split('\0')
    if (name && sha) local.set(name, sha)
  }
  const tips: Record<string, string> = {}
  for (const name of head ? [head, ...branches] : branches) {
    const sha = local.get(name)
    if (sha) tips[name] = sha
  }
  const names = Object.keys(tips)
  if (names.length === 0) return { ...EMPTY_BRANCH_GRAPH, head }
  const log = await git(['log', '--topo-order', `-n${limit + 1}`, `--format=${GRAPH_LOG_FORMAT}`, ...names.map(name => `refs/heads/${name}`), '--'])
  const commits = parseGraphLog(log)
  return { commits: commits.slice(0, limit), tips, head, more: commits.length > limit }
}

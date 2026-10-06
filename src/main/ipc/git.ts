import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import type {
  CommitHistoryResult,
  GitDiffSummary,
  GitOperationResult,
  GitPostureLastCommit,
  GitPostureResult,
  GitRepoStatus,
  GitStatusResult
} from '../../shared/types'
import { parseNumstat } from '../git-diff-summary'
import { nestedGitRepos, repoForPath, toProjectEntries, toRepoPath } from '../git-repos'
import { GIT_STATUS_ARGS, parseGitStatusZ } from '../git-status-parse'
import { findGitBashExe } from '../shell-env'
import type { IpcRegistrar } from './registrar'
import { str, stringList } from './schemas'

const execFileAsync = promisify(execFile)

const EMPTY_POSTURE: GitPostureResult = {
  isGitRepo: false, branch: null, upstream: null,
  ahead: 0, behind: 0, dirtyCount: 0, lastCommit: null
}

/** `git status --porcelain=v2 --branch` → branch, upstream, ahead/behind and dirty count. */
export function parseGitPostureStatus(stdout: string): Omit<GitPostureResult, 'isGitRepo' | 'lastCommit'> {
  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let dirtyCount = 0
  for (const line of stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim()
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/)
      if (m) { ahead = Number(m[1]); behind = Number(m[2]) }
    } else if (!line.startsWith('#')) {
      dirtyCount += 1
    }
  }
  return { branch, upstream, ahead, behind, dirtyCount }
}

/** `git log -1 --format=%H%x00%s%x00%an%x00%cI` → the last commit, or null for an empty repo. */
export function parseLastCommit(stdout: string): GitPostureLastCommit | null {
  const trimmed = stdout.replace(/\n+$/, '')
  if (!trimmed) return null
  const [sha, subject, author, isoDate] = trimmed.split('\x00')
  return sha ? { sha, subject: subject ?? '', author: author ?? '', isoDate: isoDate ?? '' } : null
}

/**
 * Global options for git commands the panel runs on its own (the 2-second
 * poll, diffs) inside a nested repo. Unlike the project root, which the user
 * picked, a nested `.git` can be anything that landed in the folder — an
 * unpacked archive, a vendored checkout — and its config must not get to run
 * commands just because the git panel is open:
 *  - `core.fsmonitor` names a command git runs on every status;
 *  - without `--no-optional-locks`, status rewrites the index, which fires
 *    the repo's `post-index-change` hook.
 * Clean filters can't be switched off this way; see `nestedRepoRunsFilters`.
 */
const NESTED_READ_OPTS = ['-c', 'core.fsmonitor=false', '--no-optional-locks']

/**
 * Whether a nested repo's own config (includes followed) defines filter
 * drivers that status/diff would run. The panel leaves such a repo unscanned.
 * Drivers from the user's global/system config (e.g. git-lfs) are fine.
 * Fails closed: only exit 1 ("no match") clears the repo — an unreadable
 * config or a git too old for `--show-scope` (< 2.26) counts as unsafe.
 */
export async function nestedRepoRunsFilters(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['config', '--show-scope', '--get-regexp', '^filter\\..*\\.(clean|process)$'], { cwd }
    )
    return stdout.split('\n').some(line => line && !/^(global|system|command)\t/.test(line))
  } catch (err) {
    return (err as { code?: unknown }).code !== 1
  }
}

async function hasHeadCommit(cwd: string, opts: string[]): Promise<boolean> {
  try {
    await execFileAsync('git', [...opts, 'rev-parse', '--verify', 'HEAD'], { cwd })
    return true
  } catch {
    return false
  }
}

async function readUntrackedSummary(cwd: string, opts: string[]): Promise<GitDiffSummary> {
  try {
    // Count lines via a shell pipeline instead of reading every untracked file
    // into Node.js — projects with hundreds of untracked files (e.g. vendored
    // dependencies) would otherwise cause 100% CPU on the 2-second poll.
    const script =
      `git ${opts.join(' ')} ls-files --others --exclude-standard -z | xargs -0 wc -l 2>/dev/null | tail -1`
    const file = process.platform === 'win32' ? findGitBashExe() : '/bin/sh'
    if (!file) return { added: 0, deleted: 0 }
    const args = process.platform === 'win32' ? ['-lc', script] : ['-c', script]
    const { stdout } = await execFileAsync(file, args, { cwd, timeout: 5000 })
    const added = parseInt(stdout.trim(), 10) || 0
    return { added, deleted: 0 }
  } catch {
    return { added: 0, deleted: 0 }
  }
}

async function readGitDiffSummary(cwd: string, nested: boolean): Promise<GitDiffSummary> {
  const opts = nested ? NESTED_READ_OPTS : []
  const untrackedSummary = await readUntrackedSummary(cwd, opts)

  try {
    const diffArgs = await hasHeadCommit(cwd, opts)
      ? ['diff', '--numstat', 'HEAD']
      : ['diff', '--numstat', '--cached']
    // `dirty` compares only the commit a submodule points at, so git doesn't
    // run status inside a nested repo's submodules.
    const { stdout } = await execFileAsync('git', [
      ...opts, ...diffArgs, ...(nested ? ['--ignore-submodules=dirty'] : []), '--'
    ], { cwd })
    const trackedSummary = parseNumstat(stdout)
    return {
      added: trackedSummary.added + untrackedSummary.added,
      deleted: trackedSummary.deleted + untrackedSummary.deleted
    }
  } catch {
    return untrackedSummary
  }
}

/** One repo's status and line summary, or null when `cwd` is not inside a git repo. */
async function readRepoStatus(cwd: string, nested: boolean): Promise<(ReturnType<typeof parseGitStatusZ> & { summary: GitDiffSummary }) | null> {
  const args = nested ? [...NESTED_READ_OPTS, ...GIT_STATUS_ARGS, '--ignore-submodules=dirty'] : GIT_STATUS_ARGS
  try {
    const [{ stdout }, summary] = await Promise.all([
      execFileAsync('git', args, { cwd }),
      readGitDiffSummary(cwd, nested)
    ])
    return { ...parseGitStatusZ(stdout), summary }
  } catch {
    return null
  }
}

function operationFailure(err: unknown): GitOperationResult {
  const stderr = (err as { stderr?: string })?.stderr?.trim()
  return { success: false, message: stderr || (err instanceof Error ? err.message : String(err)) }
}

export interface GitDeps {
  /** Real path of an allowed local project/workspace directory, or a throw. */
  resolveRoot: (projectCwd: string) => Promise<string>
}

/**
 * The git panel, posture badge and commit heatmap. The directory must be a
 * known local project/workspace: a refused one reads like "not a git repo"
 * for the read-only queries and as a failed operation for the mutating ones,
 * the same shapes the renderer already handles.
 */
export function registerGitHandlers(ipc: IpcRegistrar, deps: GitDeps): void {
  const rootOrNull = async (projectCwd: string): Promise<string | null> => {
    try {
      return await deps.resolveRoot(projectCwd)
    } catch {
      return null
    }
  }

  /**
   * The directory of `repo` (project-relative, `''` for the root) inside an
   * allowed project. A nested repo must be one the scan found, so a renderer
   * can't point git at an arbitrary subdirectory.
   */
  const resolveRepo = async (projectCwd: string, repo: string): Promise<string> => {
    const root = await deps.resolveRoot(projectCwd)
    if (!repo) return root
    if (!(await nestedGitRepos(root)).includes(repo) && !(await nestedGitRepos(root, { fresh: true })).includes(repo)) {
      throw new Error(`Not a git repository in this project: ${repo}`)
    }
    return path.join(root, ...repo.split('/'))
  }

  /** Project-relative paths as paths inside `repo`; a path outside it is refused. */
  const repoPaths = (repo: string, files: string[]): string[] => files.map((file) => {
    const inner = toRepoPath(repo, file)
    if (inner === null) throw new Error(`${file} is not inside ${repo}`)
    return inner
  })

  /** A mutating git command in an allowed repo, reported as a GitOperationResult. */
  const operation = (
    run: (cwd: string) => Promise<GitOperationResult>
  ) => async (projectCwd: string, repo: string): Promise<GitOperationResult> => {
    try {
      return await run(await resolveRepo(projectCwd, repo))
    } catch (err) {
      return operationFailure(err)
    }
  }

  ipc.handle('git-project-posture', [str], async (_event, projectCwd): Promise<GitPostureResult> => {
    const cwd = await rootOrNull(projectCwd)
    if (!cwd) return { ...EMPTY_POSTURE }
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain=v2', '--branch'], { cwd })
      const status = parseGitPostureStatus(stdout)
      let lastCommit: GitPostureLastCommit | null = null
      try {
        const { stdout: logOut } = await execFileAsync('git', ['log', '-1', '--format=%H%x00%s%x00%an%x00%cI'], { cwd })
        lastCommit = parseLastCommit(logOut)
      } catch { /* repo with zero commits */ }
      return { isGitRepo: true, ...status, lastCommit }
    } catch {
      return { ...EMPTY_POSTURE }
    }
  })

  ipc.handle('git-commit-history', [str], async (_event, projectCwd): Promise<CommitHistoryResult> => {
    const cwd = await rootOrNull(projectCwd)
    if (!cwd) return { commits: [] }
    try {
      const { stdout } = await execFileAsync('git', ['log', '--format=%cI'], { cwd, maxBuffer: 32 * 1024 * 1024 })
      const commits = stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0)
      return { commits }
    } catch {
      return { commits: [] }
    }
  })

  ipc.handle('fb-git-status', [str], async (_event, projectCwd): Promise<GitStatusResult> => {
    const result: GitStatusResult = { staged: [], unstaged: [], untracked: [], summary: { added: 0, deleted: 0 }, repos: [] }
    const cwd = await rootOrNull(projectCwd)
    if (!cwd) return result
    const nested = await nestedGitRepos(cwd)
    // The root is whatever repo git finds from the project folder (possibly
    // none); nested repos are the subfolders with their own `.git`.
    const repos = ['', ...nested]
    const statuses = await Promise.all(repos.map(async (repo) => {
      const dir = path.join(cwd, ...repo.split('/'))
      if (repo && await nestedRepoRunsFilters(dir)) return 'skipped' as const
      return readRepoStatus(dir, repo !== '')
    }))
    statuses.forEach((status, i) => {
      if (!status) return
      const repo = repos[i]
      if (status === 'skipped') {
        result.repos.push({
          path: repo, staged: [], unstaged: [], untracked: [],
          skipped: 'Not scanned: this repo\'s own git config defines filter commands that git would run (or its config could not be checked).'
        })
        return
      }
      const entry: GitRepoStatus = {
        path: repo,
        staged: toProjectEntries(repo, status.staged, nested),
        unstaged: toProjectEntries(repo, status.unstaged, nested),
        untracked: toProjectEntries(repo, status.untracked, nested)
      }
      result.repos.push(entry)
      result.staged.push(...entry.staged)
      result.unstaged.push(...entry.unstaged)
      result.untracked.push(...entry.untracked)
      result.summary.added += status.summary.added
      result.summary.deleted += status.summary.deleted
    })
    return result
  })

  ipc.handle('fb-git-diff', [str, str], async (_event, projectCwd, relativeFilePath): Promise<string> => {
    const root = await rootOrNull(projectCwd)
    if (!root) return ''
    try {
      const repo = repoForPath(await nestedGitRepos(root), relativeFilePath)
      const cwd = path.join(root, ...repo.split('/').filter(Boolean))
      const repoPath = toRepoPath(repo, relativeFilePath) ?? relativeFilePath
      // The trailing `--` keeps a path that starts with `-` from being read
      // as an option; the raw path is passed through untouched.
      if (repo && await nestedRepoRunsFilters(cwd)) return ''
      const opts = repo ? [...NESTED_READ_OPTS, 'show', '--no-textconv'] : ['show']
      const { stdout } = await execFileAsync('git', [...opts, `HEAD:${repoPath}`, '--'], { cwd })
      return stdout
    } catch {
      return ''
    }
  })

  ipc.handle('fb-git-stage', [str, str, stringList], (_event, projectCwd, repo, files) => operation(async (cwd) => {
    await execFileAsync('git', ['add', '--', ...repoPaths(repo, files)], { cwd, timeout: 10000 })
    return { success: true, message: `Staged ${files.length} file(s)` }
  })(projectCwd, repo))

  ipc.handle('fb-git-unstage', [str, str, stringList], (_event, projectCwd, repo, files) => operation(async (cwd) => {
    await execFileAsync('git', ['reset', 'HEAD', '--', ...repoPaths(repo, files)], { cwd, timeout: 10000 })
    return { success: true, message: `Unstaged ${files.length} file(s)` }
  })(projectCwd, repo))

  ipc.handle('fb-git-discard', [str, str, stringList], (_event, projectCwd, repo, files) => operation(async (cwd) => {
    await execFileAsync('git', ['checkout', '--', ...repoPaths(repo, files)], { cwd, timeout: 10000 })
    return { success: true, message: `Discarded changes in ${files.length} file(s)` }
  })(projectCwd, repo))

  ipc.handle('fb-git-pull', [str, str], (_event, projectCwd, repo) => operation(async (cwd) => {
    const { stdout, stderr } = await execFileAsync('git', ['pull'], { cwd, timeout: 60000 })
    return { success: true, message: stdout.trim() || stderr.trim() || 'Pull complete' }
  })(projectCwd, repo))

  ipc.handle('fb-git-commit', [str, str, str], async (_event, projectCwd, repo, commitMessage) => {
    if (!commitMessage || !commitMessage.trim()) {
      return { success: false, message: 'Commit message cannot be empty' }
    }
    return operation(async (cwd) => {
      const { stdout } = await execFileAsync('git', ['commit', '-m', commitMessage.trim()], { cwd, timeout: 30000 })
      return { success: true, message: stdout.trim() || 'Committed' }
    })(projectCwd, repo)
  })

  ipc.handle('fb-git-push', [str, str], (_event, projectCwd, repo) => operation(async (cwd) => {
    const { stdout, stderr } = await execFileAsync('git', ['push'], { cwd, timeout: 60000 })
    return { success: true, message: stdout.trim() || stderr.trim() || 'Push complete' }
  })(projectCwd, repo))
}

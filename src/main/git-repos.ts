import { promises as fs } from 'fs'
import path from 'path'
import type { GitStatusEntry } from '../shared/types'

/**
 * Nested repositories: a project folder that holds several independent git
 * checkouts (or keeps some files outside git on purpose) gets a git panel
 * block per repo. Repo paths are project-relative and `/`-separated; the
 * project root itself is `''`.
 */

/** How many directory levels below the project root are searched for `.git`. */
export const NESTED_REPO_MAX_DEPTH = 3
/** Safety cap: the scan runs on the 2-second git poll (behind a cache). */
const MAX_DIRS_VISITED = 2000
const MAX_NESTED_REPOS = 20
const DISCOVERY_TTL_MS = 10_000

/** Never descended into: dependency trees and dot-directories (`.git`, `.venv`, …). */
function skipDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === '__pycache__'
}

/**
 * Directories below `root` that contain a `.git` entry (a directory, or a
 * file for worktrees and submodules), breadth-first, nearest first. Symlinks
 * are not followed.
 */
export async function findNestedGitRepos(root: string, maxDepth = NESTED_REPO_MAX_DEPTH): Promise<string[]> {
  const repos: string[] = []
  let queue: string[] = ['']
  let visited = 0
  for (let depth = 0; depth < maxDepth && queue.length > 0; depth += 1) {
    const next: string[] = []
    for (const rel of queue) {
      let entries
      try {
        entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || skipDir(entry.name)) continue
        if (++visited > MAX_DIRS_VISITED) return repos
        const childRel = rel ? `${rel}/${entry.name}` : entry.name
        try {
          await fs.lstat(path.join(root, childRel, '.git'))
          repos.push(childRel)
          if (repos.length >= MAX_NESTED_REPOS) return repos
        } catch { /* not a repo root */ }
        next.push(childRel)
      }
    }
    queue = next
  }
  return repos
}

const discoveryCache = new Map<string, { at: number; repos: string[] }>()

/** `findNestedGitRepos`, cached per root for a few seconds. */
export async function nestedGitRepos(root: string, opts: { fresh?: boolean } = {}): Promise<string[]> {
  const cached = discoveryCache.get(root)
  if (!opts.fresh && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.repos
  const repos = await findNestedGitRepos(root)
  discoveryCache.set(root, { at: Date.now(), repos })
  return repos
}

/** The deepest repo (from `repos`, plus the root `''`) that holds a project-relative path. */
export function repoForPath(repos: string[], relativePath: string): string {
  let best = ''
  for (const repo of repos) {
    if (relativePath.startsWith(`${repo}/`) && repo.length > best.length) best = repo
  }
  return best
}

/** A repo-relative path as a project-relative one. */
export function toProjectPath(repo: string, repoPath: string): string {
  return repo ? `${repo}/${repoPath}` : repoPath
}

/** A project-relative path as a path inside `repo`, or null when it lies outside it. */
export function toRepoPath(repo: string, projectPath: string): string | null {
  if (!repo) return projectPath
  return projectPath.startsWith(`${repo}/`) ? projectPath.slice(repo.length + 1) : null
}

/**
 * Prefix a repo's status entries with the repo path, dropping the `?? sub/`
 * record a parent repo reports for each nested repo it doesn't ignore — those
 * files are listed under the nested repo's own block.
 */
export function toProjectEntries(repo: string, entries: GitStatusEntry[], allRepos: string[]): GitStatusEntry[] {
  const nestedDirs = new Set(allRepos.filter(r => r !== repo).map(r => `${r}/`))
  return entries
    .map(e => ({
      ...e,
      relativePath: toProjectPath(repo, e.relativePath),
      ...(e.origPath ? { origPath: toProjectPath(repo, e.origPath) } : {})
    }))
    .filter(e => !(e.status === '?' && nestedDirs.has(e.relativePath)))
}

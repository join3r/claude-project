import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import type { HostDirListing, HostRepoDiscovery, HostCloneResult } from '../shared/host-fs'

/**
 * A host's own file system, for adding projects to it (a DevTool server's
 * folder browser, "Clone repository" and "Found on this server"; plan step 6).
 * Plain Node: the same code answers for this desktop and for a server.
 */

/** `~` and `~/x` are the home dir; '' is too. Anything else must be absolute. */
export function expandHostPath(input: string, home: string = os.homedir()): string {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed === '~') return home
  if (trimmed.startsWith('~/')) return path.join(home, trimmed.slice(2))
  if (!path.isAbsolute(trimmed)) throw new Error(`Not an absolute path: ${input}`)
  return path.resolve(trimmed)
}

const MAX_LISTED = 2000

async function isDirectory(full: string, entry: fs.Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return (await fs.promises.stat(full)).isDirectory()
  } catch {
    return false
  }
}

function hasGit(dir: string): boolean {
  try {
    fs.statSync(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/** The folders in `dir` (the home dir for ''), by name; hidden ones only with `showHidden`. */
export async function listHostDirectories(dir: string, options: { showHidden?: boolean; home?: string } = {}): Promise<HostDirListing> {
  const home = options.home ?? os.homedir()
  const full = expandHostPath(dir, home)
  const entries = await fs.promises.readdir(full, { withFileTypes: true })
  const dirs: HostDirListing['entries'] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))) {
    if (!options.showHidden && entry.name.startsWith('.')) continue
    const child = path.join(full, entry.name)
    if (!(await isDirectory(child, entry))) continue
    dirs.push({ name: entry.name, path: child, git: hasGit(child) })
    if (dirs.length >= MAX_LISTED) break
  }
  const parent = path.dirname(full)
  return { path: full, parent: parent === full ? null : parent, home, git: hasGit(full), entries: dirs }
}

/** Folders never worth walking into for repos: caches, dependencies, build output, OS stores. */
export const DISCOVERY_SKIP = new Set([
  'node_modules', 'Library', 'Applications', 'Pictures', 'Movies', 'Music', 'Photos',
  'snap', 'go', 'venv', '__pycache__', 'dist', 'build', 'target', 'vendor', 'out'
])

export interface DiscoverOptions {
  /** Where to start; the home dir by default (or `DEVTOOL_DISCOVER_ROOT`, for tests). */
  root?: string
  /** How many levels below the root to look (default 3). */
  maxDepth?: number
  /** Give up after this long and report what was found (default 3 s). */
  timeLimitMs?: number
  /** At most this many repos (default 200). */
  maxRepos?: number
  now?: () => number
}

/**
 * Git repos under the root, breadth first, `maxDepth` levels down. A repo's own
 * folders aren't searched further, hidden folders and {@link DISCOVERY_SKIP} are
 * skipped, and the walk stops at the time limit (`truncated`).
 */
export async function discoverHostRepos(options: DiscoverOptions = {}): Promise<HostRepoDiscovery> {
  const root = expandHostPath(options.root ?? process.env.DEVTOOL_DISCOVER_ROOT ?? '')
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 3, 6))
  const limit = options.timeLimitMs ?? 3000
  const maxRepos = options.maxRepos ?? 200
  const now = options.now ?? (() => Date.now())
  const deadline = now() + limit
  const repos: HostRepoDiscovery['repos'] = []
  let truncated = false
  let level: string[] = [root]
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      if (now() > deadline || repos.length >= maxRepos) {
        truncated = true
        break
      }
      if (depth > 0 && hasGit(dir)) {
        repos.push({ name: path.basename(dir), path: dir })
        continue
      }
      if (depth === maxDepth) continue
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || DISCOVERY_SKIP.has(entry.name)) continue
        next.push(path.join(dir, entry.name))
      }
    }
    if (truncated) break
    level = next.sort((a, b) => a.localeCompare(b))
  }
  return { root, repos: repos.sort((a, b) => a.path.localeCompare(b.path)), truncated }
}

/** The folder name `git clone` would pick for `url`. */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/[/\\]+$/, '').replace(/\.git$/i, '')
  const last = cleaned.split(/[/:\\]/).pop() ?? ''
  return last.replace(/[^A-Za-z0-9._-]/g, '-') || 'repo'
}

export interface CloneRequest {
  url: string
  /** Where the clone goes (`~/projects` by default); made if missing. */
  parentDir?: string
  /** The clone's folder name (from the URL by default). */
  name?: string
}

export interface CloneDeps {
  /** Each progress line git prints (`Receiving objects:  42%…`), throttled. */
  onProgress: (line: string) => void
  env?: NodeJS.ProcessEnv
  git?: string
  timeoutMs?: number
  home?: string
}

/**
 * `git clone --progress <url> <parent>/<name>` on this host, with git's progress
 * streamed line by line. Never prompts (GIT_TERMINAL_PROMPT=0): a URL that needs
 * a password fails instead of hanging. Refuses a folder that already exists.
 */
export async function cloneHostRepo(request: CloneRequest, deps: CloneDeps): Promise<HostCloneResult> {
  const url = request.url.trim()
  if (!url) throw new Error('Enter a repository URL')
  if (url.startsWith('-')) throw new Error('Not a repository URL')
  const parent = expandHostPath(request.parentDir?.trim() || '~/projects', deps.home)
  const name = (request.name?.trim() || repoNameFromUrl(url))
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error(`Not a folder name: ${name}`)
  const target = path.join(parent, name)
  if (fs.existsSync(target)) throw new Error(`${target} already exists`)
  await fs.promises.mkdir(parent, { recursive: true })

  return await new Promise<HostCloneResult>((resolve, reject) => {
    const child = spawn(deps.git ?? 'git', ['clone', '--progress', '--', url, target], {
      cwd: parent,
      env: { ...(deps.env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const tail: string[] = []
    let lastSent = 0
    let pendingLine: string | null = null
    const emit = (line: string, force = false) => {
      const now = Date.now()
      if (!force && now - lastSent < 100) {
        pendingLine = line
        return
      }
      lastSent = now
      pendingLine = null
      deps.onProgress(line)
    }
    const onText = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split(/[\r\n]+/)) {
        const line = raw.trim()
        if (!line) continue
        tail.push(line)
        if (tail.length > 20) tail.shift()
        emit(line)
      }
    }
    child.stdout.on('data', onText)
    child.stderr.on('data', onText)
    const timer = setTimeout(() => child.kill('SIGTERM'), deps.timeoutMs ?? 30 * 60_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`Couldn't run git: ${err.message}`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (pendingLine) emit(pendingLine, true)
      if (code === 0) {
        resolve({ path: target, name })
        return
      }
      const reason = tail.filter(line => /fatal|error|denied|not found|could not/i.test(line)).pop() ?? tail.pop()
      reject(new Error(reason ?? `git clone failed (${signal ?? `exit ${code}`})`))
    })
  })
}

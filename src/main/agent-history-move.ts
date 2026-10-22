import fs from 'fs'
import os from 'os'
import path from 'path'
import { claudeProjectSlug } from './ipc/agents'
import { localSessionRoots, piSessionDirName } from './agent-session-move'
import { rebasePath } from './project-rename'
import { atomicWriteFileSync } from './atomic-write'

/**
 * A project folder that moved takes its agents' history along: Claude keeps
 * every session started in a directory under `~/.claude/projects/<slug>/` and
 * that directory's settings (trust, allowed tools, MCP servers) under
 * `projects["<dir>"]` in `~/.claude.json`; Pi keeps sessions under
 * `~/.pi/agent/sessions/--<slug>--/`. Codex keeps one tree for every directory
 * and needs nothing. This covers the folder itself and every directory below it
 * (worktrees, subfolders a terminal ran `claude` in), DevTool's tabs or not.
 *
 * Slugs are lossy (`/a/b-c` and `/a/b/c` share one), so a folder only moves
 * when its sessions say they ran under the old folder (their `cwd`), or when
 * its slug is exactly one of the project's known directories.
 */

const HEAD_BYTES = 64 * 1024

/** The `cwd` a session file records near its start, if any. */
function sessionCwd(file: string): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0)
    const match = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(buffer.subarray(0, read).toString('utf8'))
    return match ? (JSON.parse(match[1]) as string) : null
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** The directory a session folder's sessions ran in, from the first that says. */
function folderCwd(folder: string): string | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(folder).filter(name => name.endsWith('.jsonl'))
  } catch {
    return null
  }
  for (const name of entries) {
    const cwd = sessionCwd(path.join(folder, name))
    if (cwd) return cwd
  }
  return null
}

function isUnder(p: string, root: string): boolean {
  return rebasePath(p, root, '\0') !== p
}

/** Moves `source` to `target`, merging into an existing `target` without overwriting anything there. */
function moveFolder(source: string, target: string): void {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(source, target)
    return
  }
  for (const name of fs.readdirSync(source)) {
    const dest = path.join(target, name)
    if (!fs.existsSync(dest)) fs.renameSync(path.join(source, name), dest)
  }
  try {
    fs.rmdirSync(source)
  } catch {
    // Something of the same name was already there; it stays where it was.
  }
}

/** Moves the session folders under `root` that belong to `from` or below it. */
function moveSessionFolders(
  root: string,
  slugOf: (dir: string) => string,
  from: string,
  to: string,
  knownPaths: readonly string[]
): number {
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return 0
  }
  const known = new Map(knownPaths.filter(p => isUnder(p, from)).map(p => [slugOf(p), p]))
  // Below `from` a slug starts with its slug and a dash; Pi's `--…--` loses the closing dashes for that test.
  const prefix = slugOf(from).replace(/--$/, '')
  let moved = 0
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const folder = path.join(root, name)
    const cwd = folderCwd(folder)
    const ranIn = cwd && isUnder(cwd, from) ? cwd : known.get(name)
    if (!ranIn) continue
    const targetName = slugOf(rebasePath(ranIn, from, to))
    if (targetName === name) continue
    moveFolder(folder, path.join(root, targetName))
    moved++
  }
  return moved
}

/** Re-keys `~/.claude.json`'s per-directory entries for `from` and below; one already at the new path wins. */
function moveClaudeSettings(file: string, from: string, to: string): void {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  const config = JSON.parse(raw) as { projects?: Record<string, unknown> }
  const projects = config.projects
  if (!projects || typeof projects !== 'object') return
  let changed = false
  for (const key of Object.keys(projects)) {
    const next = rebasePath(key, from, to)
    if (next === key) continue
    if (!(next in projects)) projects[next] = projects[key]
    delete projects[key]
    changed = true
  }
  // Its mode stays (it holds Claude's account details).
  if (changed) atomicWriteFileSync(file, `${JSON.stringify(config, null, 2)}\n`, fs.statSync(file).mode & 0o777)
}

export interface AgentHistoryRoots {
  claudeProjects: string
  piSessions: string
  claudeJson: string
}

export function localAgentHistoryRoots(homeDir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): AgentHistoryRoots {
  return { ...localSessionRoots(homeDir, env), claudeJson: path.join(homeDir, '.claude.json') }
}

/** Moves Claude's and Pi's history and Claude's settings from `from` (and below) to `to`. Returns warnings. */
export async function moveAgentHistory(
  from: string,
  to: string,
  knownPaths: readonly string[],
  roots: AgentHistoryRoots = localAgentHistoryRoots()
): Promise<string[]> {
  const warnings: string[] = []
  const paths = [from, ...knownPaths]
  const attempt = (what: string, run: () => void) => {
    try {
      run()
    } catch (err) {
      warnings.push(`Couldn't move ${what}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  attempt('the Claude chat history', () => { moveSessionFolders(roots.claudeProjects, claudeProjectSlug, from, to, paths) })
  attempt('the Pi session history', () => { moveSessionFolders(roots.piSessions, piSessionDirName, from, to, paths) })
  attempt('Claude\'s settings for the folder', () => moveClaudeSettings(roots.claudeJson, from, to))
  return warnings
}

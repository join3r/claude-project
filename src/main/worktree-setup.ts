import { spawn } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { PendingWorktreeSetup } from '../shared/types'
import { gitOutput, LocalGitRunner, type GitRunner } from './git-runner'
import { findGitBashExe, getShellEnv } from './shell-env'
import type { SetupApprovals } from './worktree-setup-approvals'

/**
 * Per-repo setup for a new worktree, from an optional `.devtool/worktree.json`
 * at the root of the source checkout:
 *
 *   { "setup": ["npm ci"], "symlink": ["node_modules"], "copy": [".env"] }
 *
 * The source is the checkout the worktree was branched from: the project's repo
 * root for a stream worktree, the stream's worktree for a task worktree.
 */

export const WORKTREE_CONFIG_FILE = '.devtool/worktree.json'

export interface WorktreeSetupConfig {
  /** Shell commands, run in order in the new worktree's root. */
  setup: string[]
  /** Repo-relative paths linked to the source checkout's copy (e.g. `node_modules`). */
  symlink: string[]
  /** Repo-relative paths copied from the source checkout (e.g. `.env`). */
  copy: string[]
}

export type WorktreeConfigResult =
  | { ok: true; config: WorktreeSetupConfig }
  | { ok: false; error: string }

const EMPTY_CONFIG: WorktreeSetupConfig = { setup: [], symlink: [], copy: [] }

/**
 * A config path as a clean repo-relative POSIX path, or null when it is
 * absolute, climbs with `..`, names the repo root itself or reaches into `.git`.
 */
export function normalizeConfigPath(raw: string): string | null {
  const slashed = raw.trim().replace(/\\/g, '/')
  if (!slashed || slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) return null
  const segments = slashed.split('/').filter(segment => segment && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return null
  if (segments[0].toLowerCase() === '.git') return null
  return segments.join('/')
}

function pathList(value: unknown, key: 'symlink' | 'copy'): string[] | string {
  if (value === undefined) return []
  if (!Array.isArray(value)) return `"${key}" must be a list of paths`
  const paths: string[] = []
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== 'string') return `"${key}[${i}]" must be a string`
    const normal = normalizeConfigPath(entry)
    if (!normal) return `"${key}[${i}]" ("${entry}") must be a path inside the repository`
    if (!paths.includes(normal)) paths.push(normal)
  }
  return paths
}

/** Checks a parsed `worktree.json`. Unknown keys are ignored. */
export function parseWorktreeConfig(raw: unknown): WorktreeConfigResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `${WORKTREE_CONFIG_FILE} must hold a JSON object` }
  }
  const obj = raw as Record<string, unknown>
  const setup: string[] = []
  if (obj.setup !== undefined) {
    if (!Array.isArray(obj.setup)) return { ok: false, error: `${WORKTREE_CONFIG_FILE}: "setup" must be a list of commands` }
    for (const [i, command] of obj.setup.entries()) {
      if (typeof command !== 'string' || !command.trim()) {
        return { ok: false, error: `${WORKTREE_CONFIG_FILE}: "setup[${i}]" must be a non-empty command` }
      }
      setup.push(command)
    }
  }
  const symlink = pathList(obj.symlink, 'symlink')
  if (typeof symlink === 'string') return { ok: false, error: `${WORKTREE_CONFIG_FILE}: ${symlink}` }
  const copy = pathList(obj.copy, 'copy')
  if (typeof copy === 'string') return { ok: false, error: `${WORKTREE_CONFIG_FILE}: ${copy}` }
  return { ok: true, config: { setup, symlink, copy } }
}

export type LoadedWorktreeConfig =
  | { ok: true; config: WorktreeSetupConfig; /** sha256 of the file's bytes; null when there is no file. */ hash: string | null }
  | { ok: false; error: string }

/** The config at `<sourceRoot>/.devtool/worktree.json`; no file means nothing to do. */
export function readWorktreeConfig(sourceRoot: string): LoadedWorktreeConfig {
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(path.join(sourceRoot, WORKTREE_CONFIG_FILE))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, config: EMPTY_CONFIG, hash: null }
    return { ok: false, error: `Could not read ${WORKTREE_CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (err) {
    return { ok: false, error: `${WORKTREE_CONFIG_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  const checked = parseWorktreeConfig(parsed)
  if (!checked.ok) return checked
  return { ok: true, config: checked.config, hash: createHash('sha256').update(bytes).digest('hex') }
}

// ── info/exclude ─────────────────────────────────────────────────────────────

/**
 * Files DevTool writes into a worktree that must never be auto-committed:
 *  - hook injection's `.claude/settings.local.json`, in the project folder,
 *    which may be a repo subfolder (hence `**`);
 *  - the worktrees themselves, so the main checkout doesn't list them as
 *    untracked embedded repos.
 */
const BASE_EXCLUDES = ['**/.claude/settings.local.json', '/.worktrees/']

const EXCLUDE_HEADER = '# Added by DevTool for worktree setup'

/** `/<path>`, anchored and without a trailing slash: a gitignore `node_modules/` misses a symlink by that name. */
export function anchoredExcludeLine(repoPath: string): string {
  return `/${repoPath.replace(/[\\*?[]/g, '\\$&').replace(/ $/, '\\ ')}`
}

export function excludeLinesFor(config: WorktreeSetupConfig): string[] {
  const lines = [...BASE_EXCLUDES]
  for (const entry of [...config.symlink, ...config.copy]) {
    const line = anchoredExcludeLine(entry)
    if (!lines.includes(line)) lines.push(line)
  }
  return lines
}

/** The repo's git common dir (shared by all its worktrees), absolute and resolved. */
export async function gitCommonDir(runner: GitRunner, cwd: string): Promise<string> {
  const out = (await gitOutput(runner, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })).trim()
  return realpathOrSelf(path.resolve(cwd, out))
}

/** One writer per exclude file at a time: two worktrees set up at once would add the same lines twice. */
const excludeWrites = new Map<string, Promise<unknown>>()

/**
 * Appends whichever of `lines` are missing to `<commonDir>/info/exclude`,
 * which every linked worktree reads. Existing content is kept as is.
 * Returns the lines it added.
 */
export async function ensureInfoExclude(commonDir: string, lines: readonly string[]): Promise<string[]> {
  const file = path.join(commonDir, 'info', 'exclude')
  const previous = excludeWrites.get(file) ?? Promise.resolve()
  const write = previous.catch(() => {}).then(() => appendMissingLines(file, lines))
  excludeWrites.set(file, write)
  try {
    return await write
  } finally {
    if (excludeWrites.get(file) === write) excludeWrites.delete(file)
  }
}

function appendMissingLines(file: string, lines: readonly string[]): string[] {
  let current = ''
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  // Unescaped trailing whitespace is not part of a gitignore pattern.
  const present = new Set(current.split(/\r?\n/).map(line => line.replace(/(?<!\\)\s+$/, '')))
  const missing = lines.filter(line => !present.has(line))
  if (missing.length === 0) return []
  const block = [...(present.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER]), ...missing].join('\n') + '\n'
  const separator = current && !current.endsWith('\n') ? '\n' : ''
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, separator + block)
  return missing
}

// ── executor ─────────────────────────────────────────────────────────────────

export interface WorktreeSetupRequest {
  /** Root of the checkout the worktree was branched from; the config and the linked/copied files come from here. */
  sourceRoot: string
  /** Root of the new worktree. Setup commands run here. */
  worktreeRoot: string
  /** The new worktree's branch, for `DEVTOOL_BRANCH`. */
  branch: string
  runner?: GitRunner
  /** Which configs may run `setup` commands. Without it no command runs (they come back as `needs-approval`). */
  approvals?: SetupApprovals
  /** Per setup command. Defaults to {@link SETUP_COMMAND_TIMEOUT_MS}. */
  commandTimeoutMs?: number
  /** Base env for setup commands. Defaults to the user's login shell env. */
  env?: Record<string, string>
}

export type WorktreeSetupResult =
  | { status: 'ok'; log: string }
  /** `error` names the step that failed (with the tail of a command's output); later steps did not run. */
  | { status: 'failed'; error: string; log: string }
  /** Links and copies are done; the commands wait until `pending.hash` is approved for `pending.repoKey`. */
  | { status: 'needs-approval'; pending: PendingWorktreeSetup; log: string }

/** `npm ci` in a large repo can take a while. */
export const SETUP_COMMAND_TIMEOUT_MS = 10 * 60_000

/** Output kept per setup command; the tail is what explains a failure. */
const MAX_COMMAND_OUTPUT = 256 * 1024

const ERROR_TAIL_LINES = 15

/**
 * Prepares a new worktree: info/exclude lines, then `symlink`, `copy` and,
 * once the config is approved, `setup` from the source checkout's config.
 * Never throws. Stops at the first failure; whatever it already did stays
 * (the caller keeps the worktree).
 *
 * Safe to run again on the same worktree (excludes, links and copies that
 * are already there are left alone): that is how pending commands run after
 * an approval.
 */
export async function runWorktreeSetup(request: WorktreeSetupRequest): Promise<WorktreeSetupResult> {
  const log: string[] = []
  const fail = (error: string): WorktreeSetupResult => {
    log.push(`error: ${error}`)
    return { status: 'failed', error, log: log.join('\n') }
  }
  const loaded = readWorktreeConfig(request.sourceRoot)
  const config = loaded.ok ? loaded.config : EMPTY_CONFIG

  let commonDir: string
  try {
    commonDir = await gitCommonDir(request.runner ?? new LocalGitRunner(), request.worktreeRoot)
    const added = await ensureInfoExclude(commonDir, excludeLinesFor(config))
    if (added.length) log.push(`info/exclude: added ${added.join(', ')}`)
  } catch (err) {
    return fail(`Could not update .git/info/exclude: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!loaded.ok) return fail(loaded.error)

  const roots = setupRoots(request, commonDir)
  for (const [kind, entries] of [['symlink', config.symlink], ['copy', config.copy]] as const) {
    for (const entry of entries) {
      const placed = placeEntry(kind, entry, roots)
      if (placed.error !== undefined) return fail(placed.error)
      log.push(placed.message)
    }
  }

  if (config.setup.length === 0) return { status: 'ok', log: log.join('\n') }
  if (!loaded.hash || !request.approvals?.isApproved(commonDir, loaded.hash)) {
    log.push(`setup: ${config.setup.length} command(s) wait for approval`)
    return { status: 'needs-approval', pending: { repoKey: commonDir, hash: loaded.hash ?? '', commands: config.setup }, log: log.join('\n') }
  }
  const shell = setupShell()
  if (!shell) return fail('Setup commands need Git Bash, which was not found')
  const env = {
    ...(request.env ?? getShellEnv()),
    DEVTOOL_SOURCE_PATH: request.sourceRoot,
    DEVTOOL_WORKTREE_PATH: request.worktreeRoot,
    DEVTOOL_BRANCH: request.branch
  }
  for (const command of config.setup) {
    log.push(`$ ${command}`)
    const run = await runShellCommand(shell, command, {
      cwd: request.worktreeRoot,
      env,
      timeoutMs: request.commandTimeoutMs ?? SETUP_COMMAND_TIMEOUT_MS
    })
    if (run.output) log.push(run.output.replace(/\n$/, ''))
    if (run.error) {
      const tail = run.output.trimEnd().split('\n').slice(-ERROR_TAIL_LINES).join('\n')
      return fail(`Setup command \`${command}\` ${run.error}${tail ? `:\n${tail}` : ''}`)
    }
  }
  return { status: 'ok', log: log.join('\n') }
}

interface SetupRoots {
  sourceRoot: string
  worktreeRoot: string
  /** realpath of the source checkout. */
  sourceBound: string
  /** realpath of the repo's main checkout, when the repo has one. */
  mainBound: string | null
  /** realpath of the new worktree. */
  worktreeBound: string
}

function setupRoots(request: WorktreeSetupRequest, commonDir: string): SetupRoots {
  return {
    sourceRoot: request.sourceRoot,
    worktreeRoot: request.worktreeRoot,
    sourceBound: realpathOrSelf(request.sourceRoot),
    mainBound: path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null,
    worktreeBound: realpathOrSelf(request.worktreeRoot)
  }
}

type Placed = { message: string; error?: undefined } | { message?: undefined; error: string }

/**
 * One `symlink` or `copy` entry. A missing source or an existing destination
 * is skipped, not an error. The paths come from the repo, so a committed
 * symlink must not turn a link or copy into a read outside the source
 * checkout or a write outside the worktree:
 *  - no folder on the way to the source or the destination may be a symlink;
 *  - the source must resolve inside the source checkout. The one exception is
 *    a source that is itself a symlink into the repo's main checkout: a task
 *    worktree's source is the stream's worktree, whose `node_modules` is the
 *    link this function made there;
 *  - the destination's folder must resolve inside the worktree.
 */
function placeEntry(kind: 'symlink' | 'copy', entry: string, roots: SetupRoots): Placed {
  const refuse = (why: string): Placed => ({ error: `${kind} ${entry}: ${why}; refused` })
  const source = path.join(roots.sourceRoot, entry)
  const dest = path.join(roots.worktreeRoot, entry)

  const linkedSourceDir = symlinkedComponent(roots.sourceRoot, entry)
  if (linkedSourceDir) return refuse(`${linkedSourceDir} in the source checkout is a symlink`)
  if (!fs.existsSync(source)) return { message: `${kind} ${entry}: not in the source checkout, skipped` }
  const real = fs.realpathSync.native(source)
  const sourceIsLink = fs.lstatSync(source).isSymbolicLink()
  const sourceOk = isInside(real, roots.sourceBound) ||
    (sourceIsLink && roots.mainBound !== null && isInside(real, roots.mainBound))
  if (!sourceOk) return refuse(`the source resolves to ${real}, outside the repository`)

  const linkedDestDir = symlinkedComponent(roots.worktreeRoot, entry)
  if (linkedDestDir) return refuse(`${linkedDestDir} in the worktree is a symlink`)
  if (lexists(dest)) return { message: `${kind} ${entry}: already in the worktree, left alone` }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const parent = fs.realpathSync.native(path.dirname(dest))
    if (parent !== roots.worktreeBound && !isInside(parent, roots.worktreeBound)) {
      return refuse(`the destination resolves to ${parent}, outside the worktree`)
    }
    if (kind === 'symlink') {
      // Link to the real folder, so a task worktree doesn't chain through the stream's link.
      // Junctions need no privileges on Windows; the type is ignored elsewhere.
      fs.symlinkSync(real, dest, fs.statSync(real).isDirectory() ? 'junction' : 'file')
      return { message: `symlink ${entry} -> ${real}` }
    }
    fs.cpSync(real, dest, { recursive: true })
    return { message: `copy ${entry}` }
  } catch (err) {
    return { error: `Could not ${kind === 'symlink' ? 'link' : 'copy'} ${entry}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** The first existing folder between `root` and `root/entry` (exclusive) that is a symlink, if any. */
function symlinkedComponent(root: string, entry: string): string | null {
  const segments = entry.split('/')
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch {
      return null
    }
    if (stat.isSymbolicLink()) return current
  }
  return null
}

/** Strictly below `root` (both already real paths). */
function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

function lexists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch {
    return false
  }
}

/** The user's shell; Git Bash on Windows, like terminal tabs. */
function setupShell(): string | null {
  if (process.platform === 'win32') return findGitBashExe()
  return process.env.SHELL || '/bin/sh'
}

interface ShellRun {
  /** stdout and stderr interleaved, cut to the last {@link MAX_COMMAND_OUTPUT} characters. */
  output: string
  /** Set when the command did not exit 0, e.g. "exited with code 2". */
  error?: string
}

function runShellCommand(shell: string, command: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<ShellRun> {
  return new Promise(resolve => {
    let output = ''
    let timedOut = false
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > MAX_COMMAND_OUTPUT) output = output.slice(-MAX_COMMAND_OUTPUT)
    }
    const child = spawn(shell, ['-c', command], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group, so a timeout also stops what the command started (npm's children).
      detached: process.platform !== 'win32'
    })
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill()
      } catch {
        child.kill()
      }
    }, opts.timeoutMs)
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ output, error: `could not start: ${err.message}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) resolve({ output, error: `timed out after ${Math.round(opts.timeoutMs / 1000)}s` })
      else if (code === 0) resolve({ output })
      else resolve({ output, error: code !== null ? `exited with code ${code}` : `was stopped by ${signal}` })
    })
  })
}

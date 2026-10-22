import fs from 'fs'
import path from 'path'
import type { Project, ProjectsData, Stream, Tab, Task } from '../shared/types'
import type { ProjectArchive } from '../shared/archive'
import type { TabStatusValue } from '../shared/types'
import { projectTasks, taskTabs } from '../shared/streams'
import { type GitRunner, gitErrorText } from './git-runner'
import { isPathInside } from './ipc/path-allowlist'
import { ProjectDirError, validateFolderName } from './project-dirs'

/**
 * Renaming a project together with its folder (Rename… with "Also rename the
 * folder"). A project's tasks and tabs are only records and get rewritten; what
 * can't follow a folder that moves under it is a running process. So a rename
 * is refused while work would be lost (an agent working, a landing, a worktree
 * being set up, unsaved files), and otherwise stops the project's live tabs,
 * which start again in the new folder when next shown, the way they do after
 * a restart of the app. Worktrees live in `<folder>/.worktrees`, so they move
 * along; `git worktree repair` then fixes git's links both ways.
 */

export interface RunningTabs {
  /** Plain terminals. */
  terminals: number
  /** Terminal agents (Claude Code, Codex, Pi). */
  agents: number
  /** Claude chats. */
  chats: number
}

export interface RenameCheck {
  /** The folder it would become; the current one when only the name changes. */
  target: string
  /** Why it can't be done now, in words for the dialog. Empty: it can. */
  blockers: string[]
  /** Live tabs that would be stopped (and start again in the new folder). */
  running: RunningTabs
}

export interface RenameResult {
  directory: string
  /** Things that went wrong after the folder moved, which the user should know about. */
  warnings: string[]
}

export interface RenameOptions {
  name: string
  /** Rename the folder too; without it only the name changes. */
  folder: boolean
  /** Stop the project's live tabs (the user confirmed). Without it, live tabs refuse the rename. */
  stop?: boolean
}

export interface ProjectRenameDeps {
  peek(): ProjectsData
  commit(data: ProjectsData): void
  statusOf(tabId: string): TabStatusValue
  /** A PTY or a chat runtime is alive for the tab. */
  isLive(tabId: string): boolean
  /** Tabs some window reported unsaved (file editors). */
  dirtyTabIds(): readonly string[]
  /** A landing or a worktree setup is in flight for the task. */
  taskBusy(taskId: string): boolean
  /** Ends these tabs' processes (scrollback stays). */
  stopTabs(tabIds: readonly string[]): void
  /** Tells every window to mount these tabs again (they spawn in the new folder). */
  announceRestart(tabIds: readonly string[]): void
  archive: {
    load(projectId: string): ProjectArchive
    update(projectId: string, fn: (archive: ProjectArchive) => ProjectArchive): ProjectArchive
  }
  git: GitRunner
  /** Moves the agents' per-folder history and settings from `from` (and below) to `to`. */
  moveAgentHistory(from: string, to: string, extraPaths: readonly string[]): Promise<string[]>
  rename?: (from: string, to: string) => Promise<void>
}

function isFolderProject(project: Project): boolean {
  return !project.ssh && !project.shellCommand && typeof project.directory === 'string' && !!project.directory
}

const TERMINAL_AGENTS = new Set<Tab['type']>(['claude', 'codex', 'pi'])

function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** `p` under `from` re-rooted under `to` (both separators, for Windows paths); anything else as it was. */
export function rebasePath(p: string, from: string, to: string): string {
  if (p === from) return to
  for (const sep of ['/', '\\']) {
    if (p.startsWith(from + sep)) return to + p.slice(from.length)
  }
  return p
}

/** Every string in `value` that is `from` or a path below it, re-rooted under `to`. */
export function rebasePathsDeep<T>(value: T, from: string, to: string): T {
  if (typeof value === 'string') return rebasePath(value, from, to) as T
  if (Array.isArray(value)) return value.map(item => rebasePathsDeep(item, from, to)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = rebasePathsDeep(item, from, to)
    return out as T
  }
  return value
}

/** Worktree folders git knows for this project: its streams' and tasks', open and archived. */
function worktreePaths(project: Project, archive: ProjectArchive): string[] {
  const paths = new Set<string>()
  const addStream = (stream: Stream) => {
    if (stream.workspace?.worktreePath) paths.add(stream.workspace.worktreePath)
    for (const task of stream.tasks) if (task.workspace?.worktreePath) paths.add(task.workspace.worktreePath)
  }
  const addTask = (task: Task) => { if (task.workspace?.worktreePath) paths.add(task.workspace.worktreePath) }
  project.streams.forEach(addStream)
  for (const entry of archive.tasks) addTask(entry.task)
  for (const entry of archive.streams) {
    addStream(entry.stream)
    for (const done of entry.doneTasks) addTask(done.task)
  }
  return [...paths]
}

async function checkRename(deps: ProjectRenameDeps, project: Project, options: RenameOptions): Promise<RenameCheck> {
  const blockers: string[] = []
  const running: RunningTabs = { terminals: 0, agents: 0, chats: 0 }
  const dir = project.directory
  const folderName = validateFolderName(options.name)
  const target = options.folder ? path.join(path.dirname(dir), folderName) : dir
  if (!options.folder || target === dir) return { target: dir, blockers, running }

  if (!exists(dir)) blockers.push(`The folder ${dir} is gone. Point the project at its new place in Project settings first.`)
  // A case-only rename names the same folder on a case-insensitive disk.
  else if (target.toLowerCase() !== dir.toLowerCase() && exists(target)) blockers.push(`${target} already exists.`)

  for (const other of deps.peek().projects) {
    if (other.id === project.id || !isFolderProject(other) || other.host) continue
    if (isPathInside(dir, other.directory)) blockers.push(`Project "${other.name}" lives in this folder too.`)
  }

  // A subfolder of a bigger repository is part of that repository's files: renaming it is a commit, not a move.
  if (exists(dir)) {
    const top = await deps.git.run(['rev-parse', '--show-toplevel'], { cwd: dir })
    if (top.code === 0) {
      const root = top.stdout.trim()
      const real = await fs.promises.realpath(dir).catch(() => dir)
      if (root && path.resolve(root) !== path.resolve(real)) {
        blockers.push(`This folder is inside the git repository at ${root}; renaming it would change that repository's files.`)
      }
    }
  }

  const dirty = new Set(deps.dirtyTabIds())
  const unsaved: string[] = []
  const working: string[] = []
  const busy: string[] = []
  for (const task of projectTasks(project)) {
    const state = task.landing?.state
    if (state === 'landing' || state === 'conflict' || state === 'fixing' || deps.taskBusy(task.id)) busy.push(task.name)
    for (const tab of taskTabs(task)) {
      if (dirty.has(tab.id)) unsaved.push(tab.title || task.name)
      // A plain terminal reads as working while it prints; only an agent's turn would be lost.
      if (tab.type !== 'terminal' && deps.statusOf(tab.id) === 'working') working.push(task.name)
      if (!deps.isLive(tab.id)) continue
      if (tab.type === 'claude-chat') running.chats++
      else if (TERMINAL_AGENTS.has(tab.type)) running.agents++
      else running.terminals++
    }
  }
  const list = (names: string[]) => [...new Set(names)].map(n => `"${n}"`).join(', ')
  if (working.length > 0) blockers.push(`Wait for the agents working in ${list(working)} to finish.`)
  if (busy.length > 0) blockers.push(`Finish or abort the landing or worktree setup of ${list(busy)}.`)
  if (unsaved.length > 0) blockers.push(`Save or close ${list(unsaved)}.`)
  return { target, blockers, running }
}

/** What renaming would do, or why it can't, without changing anything. */
export async function checkProjectRename(deps: ProjectRenameDeps, projectId: string, options: RenameOptions): Promise<RenameCheck> {
  return checkRename(deps, findProject(deps, projectId), options)
}

function findProject(deps: ProjectRenameDeps, projectId: string): Project {
  const project = deps.peek().projects.find(p => p.id === projectId)
  if (!project) throw new ProjectDirError('invalid', 'That project is gone.')
  if (!isFolderProject(project) || project.host) throw new ProjectDirError('invalid', 'Only a project with a folder on this computer or a DevTool server can be renamed with its folder.')
  return project
}

export async function renameProject(deps: ProjectRenameDeps, projectId: string, options: RenameOptions): Promise<RenameResult> {
  const project = findProject(deps, projectId)
  const name = options.name.trim()
  const check = await checkRename(deps, project, options)
  if (check.blockers.length > 0) throw new ProjectDirError('invalid', check.blockers.join(' '))
  const from = project.directory
  const to = check.target
  if (to === from) {
    deps.commit(mapProject(deps.peek(), projectId, p => ({ ...p, name })))
    return { directory: from, warnings: [] }
  }

  const live = projectTasks(project).flatMap(task => taskTabs(task).map(tab => tab.id)).filter(id => deps.isLive(id))
  if (live.length > 0 && !options.stop) {
    throw new ProjectDirError('invalid', 'Tabs of this project are running; confirm stopping them to rename its folder.')
  }
  deps.stopTabs(live)
  // Windows drop their copies first; they mount again when the new folder arrives with the commit below.
  deps.announceRestart(live)

  const archive = deps.archive.load(projectId)
  const oldWorktrees = worktreePaths(project, archive)
  await (deps.rename ?? ((a, b) => fs.promises.rename(a, b)))(from, to)

  const warnings: string[] = []
  const moved = oldWorktrees.map(p => rebasePath(p, from, to)).filter(p => p !== from && exists(p))
  if (moved.length > 0) {
    const repair = await deps.git.run(['worktree', 'repair', ...moved], { cwd: to })
    if (repair.code !== 0) warnings.push(`git worktree repair failed: ${gitErrorText(['worktree', 'repair'], repair)}`)
  }
  // Before the commit: a chat that mounts again resumes in the new folder, where its history must already be.
  warnings.push(...await deps.moveAgentHistory(from, to, oldWorktrees).catch((err: unknown) => [
    `Couldn't move the agents' history: ${err instanceof Error ? err.message : String(err)}`
  ]))
  deps.commit(mapProject(deps.peek(), projectId, p => ({ ...rebasePathsDeep(p, from, to), name })))
  deps.archive.update(projectId, a => rebasePathsDeep(a, from, to))
  return { directory: to, warnings }
}

function mapProject(data: ProjectsData, projectId: string, fn: (project: Project) => Project): ProjectsData {
  return { ...data, projects: data.projects.map(p => (p.id === projectId ? fn(p) : p)) }
}

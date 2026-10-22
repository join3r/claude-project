import fs from 'fs'
import os from 'os'
import path from 'path'
import { createMainStream, type Project, type ProjectsData } from '../shared/types'
import { type GitRunner, gitErrorText } from './git-runner'
import { isPathInside } from './ipc/path-allowlist'

/**
 * A local project's own folder: finding the ones that are gone, making a new
 * one under Settings → Projects folder, and moving one to the Trash when its
 * project is deleted with it. SSH, server and shell projects have no folder here.
 */

function isLocalFolderProject(project: Project): boolean {
  return !project.ssh && !project.host && !project.shellCommand && typeof project.directory === 'string' && !!project.directory
}

/** ENOENT or ENOTDIR: the path (or a parent) is not there. Anything else (EACCES, …) is not "missing". */
async function isMissing(dir: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dir)
    return !stat.isDirectory()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

/** Ids of local projects whose directory no longer exists. */
export async function missingProjectDirs(projects: readonly Project[]): Promise<string[]> {
  const local = projects.filter(isLocalFolderProject)
  const missing = await Promise.all(local.map(p => isMissing(p.directory)))
  return local.filter((_, i) => missing[i]).map(p => p.id)
}

/**
 * Why a new project's folder wasn't made: no projects folder set (`no-projects-dir`),
 * a name that can't be a new folder there (`invalid`), or the disk or git failing.
 */
export class ProjectDirError extends Error {
  constructor(readonly kind: 'no-projects-dir' | 'invalid' | 'failed', message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ProjectDirError'
  }
}

/** Characters no folder name may hold on any of our platforms. */
const BAD_NAME_CHARS = /[/\\<>:"|?*\u0000-\u001f]/

/** The folder name for a new project, or an error saying why `name` can't be one. */
export function validateFolderName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new ProjectDirError('invalid', 'Give the project a name.')
  if (trimmed === '.' || trimmed === '..') throw new ProjectDirError('invalid', `"${trimmed}" can't be a folder name.`)
  if (BAD_NAME_CHARS.test(trimmed)) throw new ProjectDirError('invalid', 'A folder name can\'t contain / \\ < > : " | ? or *.')
  if (trimmed.length > 255) throw new ProjectDirError('invalid', 'That name is too long for a folder.')
  return trimmed
}

/** Makes `<projectsDir>/<name>` (it must not exist yet) and runs `git init` in it. */
export async function createProjectDir(projectsDir: string, name: string, git: GitRunner): Promise<string> {
  if (!projectsDir || !path.isAbsolute(projectsDir)) {
    throw new ProjectDirError('no-projects-dir', 'No projects folder is set. Pick one in DevTool\'s Settings → Sidebar → Projects folder.')
  }
  const folder = validateFolderName(name)
  await fs.promises.mkdir(projectsDir, { recursive: true })
  const target = path.join(projectsDir, folder)
  try {
    await fs.promises.mkdir(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectDirError('invalid', `${target} already exists.`, { cause: err })
    throw new ProjectDirError('failed', `Couldn't make ${target}: ${(err as Error).message}`, { cause: err })
  }
  const result = await git.run(['init'], { cwd: target })
  if (result.code !== 0) {
    // Nothing is in it yet; don't leave a half-made project behind.
    await fs.promises.rmdir(target).catch(() => {})
    throw new ProjectDirError('failed', `git init failed: ${gitErrorText(['init'], result)}`)
  }
  return target
}

/** A local project for a folder just made by {@link createProjectDir}, appended to the list. */
export function appendNewProject(data: ProjectsData, id: string, name: string, directory: string): ProjectsData {
  const project: Project = { id, name, directory, streams: [createMainStream(id)] }
  return { ...data, projects: [...data.projects, project], projectOrder: [...data.projectOrder, id] }
}

/**
 * The ids of local projects whose folder is gone, kept up to date for the phone's
 * inbox (SPEC.md §4.4 `missingFolder`): rechecked on {@link refresh} (the owner calls
 * it when projects change) and every `intervalMs`. Listeners hear only real changes.
 */
export class MissingFolderWatch {
  private ids: ReadonlySet<string> = new Set()
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private again = false

  constructor(private readonly projects: () => readonly Project[], private readonly intervalMs = 60_000) {}

  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  peek(): ReadonlySet<string> {
    return this.ids
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async refresh(): Promise<void> {
    // One check at a time; a change meanwhile gets one more pass after it.
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      do {
        this.again = false
        const next = await missingProjectDirs(this.projects())
        if (next.length !== this.ids.size || next.some(id => !this.ids.has(id))) {
          this.ids = new Set(next)
          for (const listener of [...this.listeners]) listener()
        }
      } while (this.again)
    } finally {
      this.running = false
    }
  }
}

export interface TrashDeps {
  trashItem: (fullPath: string) => Promise<void>
  realpath?: (p: string) => Promise<string>
  homeDir?: string
  /** Settings → Projects folder: trashing it would take every project in it. */
  projectsDir?: string
}

/**
 * Moves project `projectId`'s directory to the Trash. Refuses a folder another
 * project also lives in (the same folder or one below it), the home folder and
 * anything above it, a filesystem root, and the projects folder itself.
 */
export async function trashProjectDir(projects: readonly Project[], projectId: string, deps: TrashDeps): Promise<string> {
  const project = projects.find(p => p.id === projectId)
  if (!project) throw new Error('That project is gone.')
  if (!isLocalFolderProject(project)) throw new Error('Only a local project\'s folder can be moved to the Trash.')
  const realpath = deps.realpath ?? ((p: string) => fs.promises.realpath(p))
  const real = async (p: string) => realpath(p).catch(() => path.resolve(p))

  const dir = await realpath(project.directory)
  if (path.parse(dir).root === dir) throw new Error(`Refusing to trash ${dir}: it is a filesystem root.`)
  const home = await real(deps.homeDir ?? os.homedir())
  if (isPathInside(dir, home)) throw new Error(`Refusing to trash ${dir}: it holds your home folder.`)
  if (deps.projectsDir && dir === await real(deps.projectsDir)) {
    throw new Error(`Refusing to trash ${dir}: it is the projects folder.`)
  }
  for (const other of projects) {
    if (other.id === projectId || !isLocalFolderProject(other)) continue
    if (isPathInside(dir, await real(other.directory))) {
      throw new Error(`Refusing to trash ${dir}: project "${other.name}" lives in it too.`)
    }
  }
  await deps.trashItem(dir)
  return dir
}

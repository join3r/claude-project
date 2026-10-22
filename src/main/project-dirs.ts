import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Project } from '../shared/types'
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

/** Characters no folder name may hold on any of our platforms. */
const BAD_NAME_CHARS = /[/\\<>:"|?*\u0000-\u001f]/

/** The folder name for a new project, or an error saying why `name` can't be one. */
export function validateFolderName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Give the project a name.')
  if (trimmed === '.' || trimmed === '..') throw new Error(`"${trimmed}" can't be a folder name.`)
  if (BAD_NAME_CHARS.test(trimmed)) throw new Error('A folder name can\'t contain / \\ < > : " | ? or *.')
  if (trimmed.length > 255) throw new Error('That name is too long for a folder.')
  return trimmed
}

/** Makes `<projectsDir>/<name>` (it must not exist yet) and runs `git init` in it. */
export async function createProjectDir(projectsDir: string, name: string, git: GitRunner): Promise<string> {
  if (!projectsDir || !path.isAbsolute(projectsDir)) throw new Error('Pick a projects folder first.')
  const folder = validateFolderName(name)
  await fs.promises.mkdir(projectsDir, { recursive: true })
  const target = path.join(projectsDir, folder)
  try {
    await fs.promises.mkdir(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${target} already exists.`, { cause: err })
    throw err
  }
  const result = await git.run(['init'], { cwd: target })
  if (result.code !== 0) {
    // Nothing is in it yet; don't leave a half-made project behind.
    await fs.promises.rmdir(target).catch(() => {})
    throw new Error(`git init failed: ${gitErrorText(['init'], result)}`)
  }
  return target
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

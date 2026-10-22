import type { Project } from '../../shared/types'
import type { GitRunner } from '../git-runner'
import { createProjectDir, missingProjectDirs, trashProjectDir } from '../project-dirs'
import type { RenameCheck, RenameOptions, RenameResult } from '../project-rename'
import type { IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import { v } from './validate'

export interface ProjectDirsDeps {
  /** This host's projects. */
  getProjects: () => readonly Project[]
  /** Settings → Projects folder on this host ('' when none; a server falls back to `~/code`). */
  projectsDir: () => string
  setProjectsDir: (dir: string) => void
  git: GitRunner
  trashItem: (fullPath: string) => Promise<void>
  checkRename: (projectId: string, options: RenameOptions) => Promise<RenameCheck>
  rename: (projectId: string, options: RenameOptions) => Promise<RenameResult>
}

/**
 * A project's own folder, on whichever host it lives: which are gone, a new one
 * under the projects folder, the Trash, and the projects folder itself. A
 * leading host argument (`local` or a server id) is the desktop router's and is
 * ignored here; the trash call routes by project.
 */
export function registerProjectDirsHandlers(ipc: IpcRegistrar, deps: ProjectDirsDeps): void {
  ipc.handle('project-dirs:missing', [safeId], () => missingProjectDirs(deps.getProjects()))

  ipc.handle('project-dirs:folder', [safeId], () => deps.projectsDir())

  ipc.handle('project-dirs:set-folder', [safeId, v.string({ max: 4096 })], (_ctx, _host, dir) => {
    deps.setProjectsDir(dir.trim())
    return deps.projectsDir()
  })

  ipc.handle('project-dirs:create', [safeId, v.string({ nonEmpty: true, max: 255 })], (_ctx, _host, name) =>
    createProjectDir(deps.projectsDir(), name, deps.git))

  // Rename a project with its folder: `check` says what it would stop or why it can't, without changing anything.
  const renameOptions = v.object({
    name: v.string({ nonEmpty: true, max: 255 }),
    folder: v.boolean(),
    stop: v.optional(v.boolean())
  })
  ipc.handle('project-dirs:rename-check', [safeId, renameOptions], (_ctx, projectId, options) => deps.checkRename(projectId, options))
  ipc.handle('project-dirs:rename', [safeId, renameOptions], (_ctx, projectId, options) => deps.rename(projectId, options))

  // `checkOnly` runs the refusals without trashing, so a refused folder can stop the delete before anything is torn down.
  ipc.handle('project-dirs:trash', [safeId, v.optional(v.boolean())], async (_ctx, projectId, checkOnly) => {
    await trashProjectDir(deps.getProjects(), projectId, {
      trashItem: checkOnly ? async () => {} : deps.trashItem,
      projectsDir: deps.projectsDir() || undefined
    })
    return undefined
  })
}

import type { AppConfig, Project } from '../../shared/types'
import type { GitRunner } from '../git-runner'
import { createProjectDir, missingProjectDirs, trashProjectDir } from '../project-dirs'
import type { IpcContext, IpcRegistrar } from './registrar'
import { safeId } from './schemas'
import { v } from './validate'

export interface ProjectDirsDeps {
  /** This computer's projects (not a DevTool server's). */
  getProjects: () => readonly Project[]
  getConfig: () => AppConfig
  git: GitRunner
  trashItem: (fullPath: string) => Promise<void>
}

/** A local project's own folder: which are gone, a new one under the projects folder, and the Trash. */
export function registerProjectDirsHandlers(ipc: IpcRegistrar<IpcContext>, deps: ProjectDirsDeps): void {
  ipc.handle('project-dirs:missing', [], () => missingProjectDirs(deps.getProjects()))

  ipc.handle('project-dirs:create', [v.string({ nonEmpty: true, max: 255 })], (_ctx, name) =>
    createProjectDir(deps.getConfig().projectsDir, name, deps.git))

  // `checkOnly` runs the refusals without trashing, so a refused folder can stop the delete before anything is torn down.
  ipc.handle('project-dirs:trash', [safeId, v.optional(v.boolean())], async (_ctx, projectId, checkOnly) => {
    await trashProjectDir(deps.getProjects(), projectId, {
      trashItem: checkOnly ? async () => {} : deps.trashItem,
      projectsDir: deps.getConfig().projectsDir || undefined
    })
    return undefined
  })
}

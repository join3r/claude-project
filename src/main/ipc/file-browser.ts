import fsPromises from 'fs/promises'
import type { DirectoryEntry } from '../../shared/types'
import {
  createProjectDirectory,
  createProjectFile,
  deleteProjectEntry,
  listProjectDirectory,
  renameProjectEntry
} from '../file-browser-fs'
import { resolveConfinedPath, type RealpathApi, nodeRealpath } from './path-allowlist'
import type { IpcRegistrar } from './registrar'
import { optSafeId, str } from './schemas'

export interface FileBrowserDeps {
  /**
   * The real path of a renderer-supplied project directory, or a throw when it
   * is not a known local project/workspace directory (or below one).
   */
  resolveRoot: (projectCwd: string) => Promise<string>
  fs?: RealpathApi
}

/**
 * The file tree and editor. Every call is confined twice: the root must be an
 * allowed project directory, and the target must stay inside that root after
 * symlinks are resolved.
 */
export function registerFileBrowserHandlers(ipc: IpcRegistrar, deps: FileBrowserDeps): void {
  const fsApi = deps.fs ?? nodeRealpath
  const follow = { followFinal: true }

  ipc.handle('fb-read-directory', [str, str, optSafeId], async (_event, projectCwd, relativeDirPath): Promise<DirectoryEntry[]> => {
    const root = await deps.resolveRoot(projectCwd)
    await resolveConfinedPath(root, relativeDirPath, follow, fsApi)
    return listProjectDirectory(root, relativeDirPath)
  })

  ipc.handle('fb-read-file', [str, str, optSafeId], async (_event, projectCwd, relativeFilePath): Promise<string> => {
    const root = await deps.resolveRoot(projectCwd)
    const fullPath = await resolveConfinedPath(root, relativeFilePath, follow, fsApi)
    return fsPromises.readFile(fullPath, 'utf-8')
  })

  ipc.handle('fb-write-file', [str, str, str, optSafeId], async (_event, projectCwd, relativeFilePath, content): Promise<void> => {
    const root = await deps.resolveRoot(projectCwd)
    const fullPath = await resolveConfinedPath(root, relativeFilePath, follow, fsApi)
    await fsPromises.writeFile(fullPath, content, 'utf-8')
  })

  ipc.handle('fb-create-file', [str, str, str, optSafeId], async (_event, projectCwd, parentRelativePath, name): Promise<DirectoryEntry> => {
    const root = await deps.resolveRoot(projectCwd)
    await resolveConfinedPath(root, parentRelativePath, follow, fsApi)
    return createProjectFile(root, parentRelativePath, name)
  })

  ipc.handle('fb-create-directory', [str, str, str, optSafeId], async (_event, projectCwd, parentRelativePath, name): Promise<DirectoryEntry> => {
    const root = await deps.resolveRoot(projectCwd)
    await resolveConfinedPath(root, parentRelativePath, follow, fsApi)
    return createProjectDirectory(root, parentRelativePath, name)
  })

  // Renaming or deleting acts on the entry itself (a symlink is renamed/removed,
  // not its target), so only the directory holding it has to be inside the root.
  ipc.handle('fb-rename', [str, str, str, optSafeId], async (_event, projectCwd, fromRelativePath, newName): Promise<DirectoryEntry> => {
    const root = await deps.resolveRoot(projectCwd)
    await resolveConfinedPath(root, fromRelativePath, { followFinal: false }, fsApi)
    return renameProjectEntry(root, fromRelativePath, newName)
  })

  ipc.handle('fb-delete', [str, str, optSafeId], async (_event, projectCwd, relativePath): Promise<void> => {
    const root = await deps.resolveRoot(projectCwd)
    await resolveConfinedPath(root, relativePath, { followFinal: false }, fsApi)
    return deleteProjectEntry(root, relativePath)
  })
}

import fs from 'fs'
import path from 'path'
import type { Project } from '../../shared/types'
import { joinWorkspaceDir } from '../../shared/workspace-path'
import { resolveSafeProjectPath } from '../project-fs-path'

/**
 * The file browser, git panel and IDE launcher all take a directory from the
 * renderer. `resolveSafeProjectPath` only confines paths relative to that
 * directory, so on its own it confines to whatever root the caller picked.
 * This module pins the root itself: it must be (inside) a local project's
 * directory or one of its streams' workspace worktrees, compared after symlinks
 * are resolved.
 */

export interface RealpathApi {
  realpath(p: string): Promise<string>
}

export const nodeRealpath: RealpathApi = { realpath: (p) => fs.promises.realpath(p) }

export class PathNotAllowedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathNotAllowedError'
  }
}

/** Every local directory a window may legitimately point the file browser or git at. */
export function allowedLocalRoots(projects: readonly Project[]): string[] {
  const roots = new Set<string>()
  for (const project of projects) {
    // Remote projects' paths live on another machine; nothing local is reachable through them.
    if (project.ssh) continue
    if (typeof project.directory === 'string' && project.directory) roots.add(project.directory)
    for (const stream of Array.isArray(project.streams) ? project.streams : []) {
      const workspace = stream.workspace
      if (!workspace || typeof workspace.worktreePath !== 'string' || !workspace.worktreePath) continue
      roots.add(workspace.worktreePath)
      roots.add(joinWorkspaceDir(workspace.worktreePath, workspace.relativeProjectPath))
    }
  }
  return [...roots]
}

/** `target` is `root` or below it. Both must already be absolute and normalized. */
export function isPathInside(root: string, target: string, pathApi: typeof path.posix | typeof path.win32 = path): boolean {
  const rel = pathApi.relative(root, target)
  if (rel === '') return true
  if (pathApi.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${pathApi.sep}`)
}

/**
 * Resolve a renderer-supplied directory to its real path, provided it is one
 * of `roots` or lies below one (also compared by real path, so a symlinked
 * project directory still matches and a symlink out of one does not).
 */
export async function resolveAllowedDirectory(
  dir: unknown,
  roots: readonly string[],
  fsApi: RealpathApi = nodeRealpath
): Promise<string> {
  if (typeof dir !== 'string' || !dir) throw new PathNotAllowedError('Directory is required')
  if (!path.isAbsolute(dir)) throw new PathNotAllowedError('Directory must be an absolute path')

  let real: string
  try {
    real = await fsApi.realpath(dir)
  } catch {
    throw new PathNotAllowedError(`Directory does not exist: ${dir}`)
  }

  // Lexical matches first: the common case costs one extra realpath, not one per project.
  const lexical = path.resolve(dir)
  const ordered = [...roots].sort((a, b) => {
    const am = isPathInside(path.resolve(a), lexical) ? 0 : 1
    const bm = isPathInside(path.resolve(b), lexical) ? 0 : 1
    return am - bm
  })
  for (const root of ordered) {
    let realRoot: string
    try {
      realRoot = await fsApi.realpath(root)
    } catch {
      continue
    }
    if (isPathInside(realRoot, real)) return real
  }
  throw new PathNotAllowedError(`Directory is not a known project or workspace: ${dir}`)
}

/** Real path of `p`, or of its deepest existing ancestor with the missing tail re-appended. */
export async function realpathOfExistingPrefix(p: string, fsApi: RealpathApi = nodeRealpath): Promise<string> {
  const tail: string[] = []
  let current = p
  for (;;) {
    try {
      const real = await fsApi.realpath(current)
      return tail.length ? path.join(real, ...tail) : real
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code && code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      const parent = path.dirname(current)
      if (parent === current) return p
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}

/**
 * Resolve `relativePath` under an already-allowed real `root`, refusing both
 * lexical escapes (`..`) and symlink escapes.
 *
 * `followFinal` decides whether the last segment's own symlink matters: yes
 * for reading/writing/listing it (the operation goes through the link), no for
 * deleting or renaming it (those act on the link itself, so only its parent
 * directory has to be inside the root).
 */
export async function resolveConfinedPath(
  root: string,
  relativePath: string,
  options: { followFinal: boolean },
  fsApi: RealpathApi = nodeRealpath
): Promise<string> {
  const lexical = resolveSafeProjectPath(root, relativePath)
  const probe = options.followFinal || lexical === root ? lexical : path.dirname(lexical)
  const real = await realpathOfExistingPrefix(probe, fsApi)
  if (!isPathInside(root, real)) throw new PathNotAllowedError('Path escapes the project directory')
  return lexical
}

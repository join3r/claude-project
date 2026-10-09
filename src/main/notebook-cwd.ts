import path from 'path'
import { NOTEBOOK_ERROR_CWD } from '../shared/notebook'

type PathApi = typeof path.win32 | typeof path.posix

export { NOTEBOOK_ERROR_CWD }

/** Project folder plus each worktree root (a stream's, or a task's own). Kernel spawn may sit in any of these. */
export function notebookAllowedCwdRoots(project: {
  directory?: string
  streams?: Array<{ workspace?: { worktreePath?: string }; tasks?: Array<{ workspace?: { worktreePath?: string } }> }>
}): string[] {
  const roots: string[] = []
  const seen = new Set<string>()
  const add = (value: string | undefined) => {
    const trimmed = value?.trim() ?? ''
    if (!trimmed) return
    const key = trimmed.replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    roots.push(trimmed)
  }
  add(project.directory)
  for (const stream of project.streams ?? []) {
    add(stream.workspace?.worktreePath)
    for (const task of stream.tasks ?? []) add(task.workspace?.worktreePath)
  }
  return roots
}

function foldWin(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** True when `candidate` is `root` or a folder/file under it. Windows is case-insensitive. */
export function pathIsInsideRoot(
  candidate: string,
  root: string,
  pathApi: PathApi,
  windows: boolean
): boolean {
  const resolvedRoot = pathApi.resolve(root)
  const resolved = pathApi.resolve(candidate)
  if (windows) {
    const a = foldWin(resolved)
    const b = foldWin(resolvedRoot)
    if (a === b) return true
    const prefix = b.endsWith('\\') ? b : `${b}\\`
    return a.startsWith(prefix)
  }
  const rel = pathApi.relative(resolvedRoot, resolved)
  if (rel === '') return true
  if (pathApi.isAbsolute(rel)) return false
  return rel.split(pathApi.sep)[0] !== '..'
}

/**
 * Bind a renderer-supplied cwd to project directory / worktree roots.
 * Rejects empty paths and anything outside those roots.
 */
export function resolveNotebookKernelCwd(
  cwd: string,
  roots: string[],
  deps: { platform?: NodeJS.Platform; path?: PathApi } = {}
): { ok: true; cwd: string } | { ok: false; error: string } {
  const trimmed = cwd?.trim() ?? ''
  if (!trimmed || roots.length === 0) {
    return { ok: false, error: NOTEBOOK_ERROR_CWD }
  }
  const platform = deps.platform ?? process.platform
  const windows = platform === 'win32'
  const pathApi = deps.path ?? (windows ? path.win32 : path.posix)
  const resolved = pathApi.resolve(trimmed)
  for (const root of roots) {
    if (!root?.trim()) continue
    if (pathIsInsideRoot(resolved, root.trim(), pathApi, windows)) {
      return { ok: true, cwd: resolved }
    }
  }
  return { ok: false, error: NOTEBOOK_ERROR_CWD }
}

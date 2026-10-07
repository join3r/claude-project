import path from 'path'

/** True for `C:\...` or `\\server\share` (local Windows), not `/home/...` remotes. */
export function isWindowsAbsolutePath(dir: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(dir) || dir.startsWith('\\\\')
}

/**
 * Join a worktree root with an optional nested project folder.
 * Local Windows uses win32 join; SSH / POSIX remotes use `/`.
 */
export function joinWorkspaceDir(worktreePath: string, relativeProjectPath?: string): string {
  const rel = (relativeProjectPath ?? '').trim()
  if (!rel) return worktreePath
  if (isWindowsAbsolutePath(worktreePath)) {
    return path.win32.join(worktreePath, rel)
  }
  return path.posix.join(worktreePath.replace(/\\/g, '/'), rel.replace(/\\/g, '/'))
}

/** Git-style relative path (`apps/web`), even when `path.relative` used `\`. */
export function toPosixRelative(relativePath: string): string {
  return relativePath.replace(/\\/g, '/')
}

/** Nested file-tree keys always use `/` so they match git porcelain. */
export function posixRelativeJoin(dir: string, name: string): string {
  const prefix = toPosixRelative(dir).replace(/^\/+|\/+$/g, '')
  if (!prefix) return name
  return `${prefix}/${name}`
}

/**
 * `target` re-based from `fromDir` to `toDir` when it lies inside `fromDir`, else
 * null. Works for POSIX and Windows separators.
 */
export function retargetPath(target: string, fromDir: string, toDir: string): string | null {
  const from = fromDir.replace(/[/\\]+$/, '')
  if (!from) return null
  if (target === from || target === fromDir) return toDir
  if (!target.startsWith(from)) return null
  const rest = target.slice(from.length)
  if (!/^[/\\]/.test(rest)) return null
  return toDir.replace(/[/\\]+$/, '') + rest
}

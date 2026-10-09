import { isRemoteProject, isShellCommandProject, type ExternalEditor, type ExternalEditorsConfig, type Project, type Task } from './types'
import { taskWorkspace } from './streams'
import { joinWorkspaceDir } from './workspace-path'
import { openInIdeAvailable } from './project-features'

export function resolveDefaultExternalEditor(config: ExternalEditorsConfig): ExternalEditor | null {
  if (config.defaultId) {
    const found = config.editors.find((item) => item.id === config.defaultId)
    if (found) return found
  }
  return config.editors[0] ?? null
}

/** Palette aliases so "vscode" finds Visual Studio Code and "cursor" finds Cursor. */
export function paletteAliasesForEditor(name: string): string[] {
  const aliases = [name.toLowerCase()]
  const lower = name.toLowerCase()
  if (lower.includes('visual studio') || lower === 'code' || lower.includes('vs code')) {
    aliases.push('vscode', 'code', 'vs code')
  }
  if (lower.includes('cursor')) {
    aliases.push('cursor')
  }
  return aliases
}

/**
 * Folder the Files panel uses, which Open in IDE opens: the task's worktree (its
 * own, else its stream's), else the project directory. A DevTool server's
 * project answers its path on the server (opened over SSH), except on a
 * Windows desktop (`desktopPlatform`), where that isn't offered.
 */
export function localProjectFolder(project: Project | null | undefined, task: Task | null | undefined, desktopPlatform: string = 'darwin'): string | null {
  if (!project) return null
  if (isRemoteProject(project) || isShellCommandProject(project) || !openInIdeAvailable(project, desktopPlatform)) return null
  const workspace = taskWorkspace(project, task?.id)
  if (workspace) {
    return joinWorkspaceDir(workspace.worktreePath, workspace.relativeProjectPath)
  }
  const dir = (project.directory ?? '').trim()
  return dir || null
}

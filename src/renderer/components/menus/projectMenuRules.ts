import { isEphemeralProject, isRemoteProject, isShellCommandProject } from '../../../shared/types'
import type { Project } from '../../../shared/types'
import { featureAvailable, revealAvailable } from '../../../shared/project-features'
import { joinWorkspaceDir } from '../../../shared/workspace-path'
import { projectTasks, taskWorkspace } from '../../../shared/streams'

/**
 * The local folder a project, stream or task works in, for "Reveal in Finder":
 * the task's worktree (its own, else its stream's) or the stream's when it has
 * one, else the project directory. Remote and
 * shell-command projects have none on this machine.
 */
export function revealFolder(
  projects: readonly Project[],
  projectId: string,
  taskId?: string,
  streamId?: string
): string | null {
  const project = projects.find(p => p.id === projectId)
  if (!project || isRemoteProject(project) || isShellCommandProject(project) || !revealAvailable(project) || !featureAvailable(project, 'local-folder')) return null
  const workspace = taskId
    ? taskWorkspace(project, taskId)
    : streamId ? project.streams.find(stream => stream.id === streamId)?.workspace : undefined
  if (workspace?.worktreePath) return joinWorkspaceDir(workspace.worktreePath, workspace.relativeProjectPath)
  return project.directory || null
}

/** The confirmation for deleting a project, naming what goes with it. */
export function projectDeletePrompt(project: Project): string {
  const tasks = projectTasks(project).length
  const workspaces = project.streams.filter(s => s.workspace).length
  const lines = [`Delete project "${project.name}"?`]
  if (tasks > 0) lines.push(`${tasks === 1 ? 'Its task closes' : `Its ${tasks} tasks close`}, with their tabs.`)
  if (workspaces > 0) lines.push(`${workspaces === 1 ? 'Its workspace worktree is' : `Its ${workspaces} workspace worktrees are`} removed from disk, even with uncommitted changes.`)
  if (!isRemoteProject(project) && !isShellCommandProject(project)) lines.push('The project folder itself is not touched.')
  return lines.join('\n\n')
}

/** Whether "Delete with folder…" applies: a folder project on this computer or a DevTool server (not SSH or shell) whose folder is there. */
export function canTrashProjectFolder(project: Project, folderMissing: boolean): boolean {
  return !folderMissing && !!project.directory && !isRemoteProject(project) && !isShellCommandProject(project)
    && !isEphemeralProject(project)
}

/** The confirmation for deleting a project together with its folder. */
export function projectDeleteWithFolderPrompt(project: Project): string {
  const lines = projectDeletePrompt(project).split('\n\n').filter(line => line !== 'The project folder itself is not touched.')
  lines.push(`Its folder ${project.directory}${project.host ? ' on its server' : ''} is moved to the Trash, with everything in it.`)
  return lines.join('\n\n')
}

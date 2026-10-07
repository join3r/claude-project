import type { Project, SshConfig, Task } from './types'
import { taskWorkspace } from './streams'
import { joinWorkspaceDir } from './workspace-path'

/**
 * What a Claude chat tab's runtime is started from (`ChatTabConfig` in
 * src/main/claude-chat/chat-manager.ts). The renderer's ClaudeChatTab builds it from
 * its props; main's mobile bridge builds it from the stored project, and both must
 * agree or a phone would start the chat somewhere else than a window would.
 */
export interface ChatTabConfigShape {
  cwd: string
  sessionId: string
  projectId?: string
  sshConfig?: SshConfig
  extraArgs?: string[]
}

/** A project's extra CLI args (`aiToolArgs`), split the way the tabs split them. */
export function splitExtraArgs(extraArgs?: string): string[] {
  return extraArgs ? extraArgs.trim().split(/\s+/).filter(Boolean) : []
}

/** The directory a task's tabs run in: its worktree when it has one, else the project's. */
export function taskDirectory(project: Project, task: Task): string {
  const workspace = taskWorkspace(project, task.id)
  if (workspace) return joinWorkspaceDir(workspace.worktreePath, workspace.relativeProjectPath)
  return project.ssh ? project.ssh.remoteDir : project.directory
}

export function chatTabConfig(project: Project, task: Task, sessionId: string): ChatTabConfigShape {
  const sshConfig = project.ssh
  return {
    cwd: taskDirectory(project, task),
    sessionId,
    projectId: sshConfig ? project.id : undefined,
    sshConfig,
    extraArgs: splitExtraArgs(project.aiToolArgs?.claude)
  }
}

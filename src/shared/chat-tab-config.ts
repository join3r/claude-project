import type { Project, SshConfig, Task } from './types'
import { taskDirectory } from './streams'

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

export function chatTabConfig(project: Project, task: Task, sessionId: string): ChatTabConfigShape {
  const sshConfig = project.ssh
  return {
    cwd: taskDirectory(project, task),
    sessionId,
    // Always: the desktop's router follows it to a server project; main treats
    // only `projectId` with `sshConfig` as SSH.
    projectId: project.id,
    sshConfig,
    extraArgs: splitExtraArgs(project.aiToolArgs?.claude)
  }
}

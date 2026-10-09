import type { AiTabType, SshConfig } from '../../shared/types'
import { splitExtraArgs } from '../../shared/chat-tab-config'

export function parseExtraArgs(extraArgs?: string): string[] {
  return splitExtraArgs(extraArgs)
}

export function buildAiToolArgs(toolType: AiTabType, parsedExtraArgs: string[], resumeSessionId?: string): string[] {
  if (toolType === 'claude') {
    return [...parsedExtraArgs, ...(resumeSessionId ? ['--resume', resumeSessionId] : [])]
  }

  if (toolType === 'codex') {
    return [
      '-c',
      'tui.notifications=true',
      '-c',
      'tui.notification_method="bel"',
      ...parsedExtraArgs,
      ...(resumeSessionId ? ['resume', resumeSessionId] : [])
    ]
  }

  if (toolType === 'pi') {
    // DevTool pre-generates a session UUID per pi tab; --session-id loads it if
    // present and creates it if missing, giving deterministic resume across restarts.
    return [...parsedExtraArgs, ...(resumeSessionId ? ['--session-id', resumeSessionId] : [])]
  }

  return parsedExtraArgs
}

/**
 * Whether an empty task's first prompt is pasted into the agent's TUI once it
 * is up rather than passed as an argument: only where the agent runs on Windows
 * (a `.cmd` shim under cmd.exe would reinterpret the argument). That is the
 * platform of the host the agent runs on, a DevTool server's when the project is
 * on one (never Windows), not this desktop's. SSH hosts are Unix.
 */
export function pastesFirstPrompt(hostPlatform: string, sshConfig: SshConfig | undefined): boolean {
  return hostPlatform === 'win32' && !sshConfig
}

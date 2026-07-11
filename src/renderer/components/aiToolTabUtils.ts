import type { AiTabType } from '../../shared/types'

export function parseExtraArgs(extraArgs?: string): string[] {
  return extraArgs ? extraArgs.trim().split(/\s+/).filter(Boolean) : []
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

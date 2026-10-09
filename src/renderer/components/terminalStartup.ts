/**
 * A terminal task's start-up command, typed into its shell once the PTY is up.
 * Held per tab id until the tab's first spawn takes it, like the prompt box's
 * pending prompts.
 */
const pendingCommands = new Map<string, string>()

export function setPendingCommand(tabId: string, command: string): void {
  const trimmed = command.trim()
  if (trimmed) pendingCommands.set(tabId, trimmed)
}

export function takePendingCommand(tabId: string): string | undefined {
  const command = pendingCommands.get(tabId)
  pendingCommands.delete(tabId)
  return command
}

/**
 * A terminal tab that runs one script instead of a login shell (an agent's
 * installer on a DevTool server): `/bin/sh -c <script>` on the tab's host, so
 * the tab ends, with its exit code, when the script does. Taken by the tab's
 * first successful spawn; a later attach (another window, a reload) finds the
 * same process, or, once it is gone, a plain shell.
 */
const pendingRuns = new Map<string, string>()

export function setPendingRun(tabId: string, script: string): void {
  if (script.trim()) pendingRuns.set(tabId, script)
}

export function peekPendingRun(tabId: string): string | undefined {
  return pendingRuns.get(tabId)
}

export function takePendingRun(tabId: string): string | undefined {
  const script = pendingRuns.get(tabId)
  pendingRuns.delete(tabId)
  return script
}

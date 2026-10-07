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

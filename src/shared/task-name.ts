/** How long a task name taken from a prompt may be: about what the sidebar shows. */
export const TASK_NAME_FROM_PROMPT_MAX = 50

/**
 * A task name from a prompt's first non-empty line, whitespace collapsed, cut with
 * an ellipsis to fit. Shared by the desktop's prompt box and the phone's `task.new`.
 */
export function taskNameFromPrompt(text: string, max = TASK_NAME_FROM_PROMPT_MAX): string {
  const line = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l.length > 0) ?? ''
  if (line.length <= max) return line
  return line.slice(0, max - 1).trimEnd() + '…'
}

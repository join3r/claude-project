const TERMINAL_REPORT_PATTERNS = [
  /\x1b\[[0-9;?]*[nR]/g,
  /\x1b\[(?:\?|>)?[0-9;]*c/g,
  /\x1b\](?:10|11|12);(?:\?|rgb:[0-9a-fA-F/]+)(?:\x07|\x1b\\)/g,
  /\x1b\[[IO]/g
]

export function sanitizeRestoredScrollback(scrollback: string): string {
  let sanitized = scrollback
  for (const pattern of TERMINAL_REPORT_PATTERNS) {
    sanitized = sanitized.replace(pattern, '')
  }
  return sanitized
}

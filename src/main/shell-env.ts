import { execFile } from 'child_process'

let resolvedEnv: Record<string, string> | null = null

/**
 * Resolve the user's shell environment by spawning a login shell.
 * On macOS, GUI apps launched from Finder get a minimal PATH.
 * This captures the full environment the user would get in a terminal.
 */
export async function resolveShellEnv(): Promise<void> {
  if (process.platform === 'win32') return

  const shell = process.env.SHELL || '/bin/zsh'

  try {
    const env = await new Promise<string>((resolve, reject) => {
      // Use -ilc to run as interactive login shell, print env with null delimiters
      execFile(shell, ['-ilc', 'env -0'], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      })
    })

    const parsed: Record<string, string> = {}
    for (const entry of env.split('\0')) {
      const idx = entry.indexOf('=')
      if (idx > 0) {
        parsed[entry.slice(0, idx)] = entry.slice(idx + 1)
      }
    }

    if (parsed.PATH) {
      resolvedEnv = parsed
      // Also fix the main process env so child_process calls benefit
      process.env.PATH = parsed.PATH
    }
  } catch {
    // Fall back to process.env if shell resolution fails
  }
}

export function getShellEnv(): Record<string, string> {
  return resolvedEnv ?? (process.env as Record<string, string>)
}

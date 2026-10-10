import { spawn } from 'child_process'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cleanTaskTitle } from '../shared/task-name'

/** Past this the task keeps its first-line name. */
export const TASK_NAMER_TIMEOUT_MS = 30_000

/** Longer prompts are cut: the start says what the task is about. */
const PROMPT_MAX = 4000

const SYSTEM_PROMPT = [
  "You name tasks in a developer's task list.",
  'Reply with only a title of 2 to 5 words that says what the task is about: its essence, not its first words.',
  'Use the language of the request, in sentence case. No quotes, no trailing period.'
].join(' ')

/** Where `claude` runs: nothing in it, so no project's CLAUDE.md is read. */
function emptyDir(): string {
  const dir = join(tmpdir(), 'devtool-task-namer')
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface TaskNamerDeps {
  /** The user's own `claude`, as chat tabs run it. */
  executable: () => string
  env: () => Record<string, string | undefined>
  log: (message: string) => void
}

/**
 * A short title for a task from its first prompt: one `claude -p` on Haiku with
 * the user's login, no tools, no settings (so no hooks) and no saved session, run
 * in an empty directory so no CLAUDE.md is read. Null on any failure; the task
 * then keeps the prompt's first line.
 */
export function suggestTaskName(prompt: string, deps: TaskNamerDeps, timeoutMs = TASK_NAMER_TIMEOUT_MS): Promise<string | null> {
  const text = prompt.trim().slice(0, PROMPT_MAX)
  if (!text) return Promise.resolve(null)
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (title: string | null, why?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (why) deps.log(`taskNamer failed: ${why}`)
      resolve(title)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(deps.executable(), [
        '-p', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--strict-mcp-config',
        '--disable-slash-commands', '--setting-sources', '', '--system-prompt', SYSTEM_PROMPT
      ], {
        cwd: emptyDir(),
        env: deps.env() as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      })
    } catch (err) {
      finish(null, err instanceof Error ? err.message : String(err))
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null, 'timed out')
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.on('error', (err) => finish(null, err.message))
    child.on('close', (code) => {
      if (code !== 0) return finish(null, `exit ${code}`)
      const title = cleanTaskTitle(out)
      finish(title, title ? undefined : `unusable reply ${JSON.stringify(out.slice(0, 80))}`)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(text)
  })
}

import { spawn } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Autopilot's "+ Codex review": one headless `codex exec` over a task's diff
 * against its stream. Codex runs read-only in the task's directory with the
 * user's own config (model, provider, flags: nothing is passed), keeps no
 * session, and answers in a fixed JSON shape so the verdict needs no guessing.
 */

export type CodexReview =
  | { status: 'clean' }
  | { status: 'findings'; text: string }
  | { status: 'failed'; error: string }

/** A review that takes longer than this is given up on. */
export const CODEX_REVIEW_TIMEOUT_MS = 20 * 60_000

const SCHEMA = {
  type: 'object',
  properties: {
    clean: { type: 'boolean' },
    findings: { type: 'string' }
  },
  required: ['clean', 'findings'],
  additionalProperties: false
}

export interface CodexReviewAsk {
  /** The commit the task's work is measured from (merge-base with the stream, or where its folder was). */
  base: string
  /** What the diff goes into, for the prompt ("the stream branch `0.7.0`"). */
  target: string
  /** The task's name: what was asked. */
  taskName: string
  /** Claude's own summary of what it did, when there is one. */
  summary?: string
}

export function codexReviewPrompt(ask: CodexReviewAsk): string {
  return [
    `Review the changes an agent made for this task: "${ask.taskName}".`,
    ...(ask.summary ? ['', `The agent's summary: ${ask.summary}`] : []),
    '',
    `The changes go into ${ask.target}. See them with \`git diff ${ask.base}\` (committed and uncommitted work)`,
    'and `git status --porcelain` (new untracked files count too). Read the surrounding code where you need to.',
    '',
    'Report only what should be fixed before this lands: bugs, broken behaviour, missed cases of the task, security problems, a build or test that will fail.',
    'Not style, naming or taste. Don\'t change any file.',
    '',
    'Answer with `clean: true` and empty `findings` when nothing needs fixing.',
    'Otherwise `clean: false`, and `findings` as a short Markdown list: file and line, what is wrong, what to do.'
  ].join('\n')
}

/** Codex's last message (the schema's JSON) as a verdict. */
export function parseCodexVerdict(raw: string): CodexReview {
  const text = raw.trim()
  if (!text) return { status: 'failed', error: 'Codex gave no answer' }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && typeof (parsed as { clean?: unknown }).clean === 'boolean') {
      const { clean, findings } = parsed as { clean: boolean; findings?: unknown }
      const list = typeof findings === 'string' ? findings.trim() : ''
      if (clean || !list) return { status: 'clean' }
      return { status: 'findings', text: list }
    }
  } catch {
    // Not JSON: a Codex that ignored the schema. Its prose is the findings.
  }
  return { status: 'findings', text }
}

/** What Claude is told when Codex found something (once per task). */
export function codexFindingsPrompt(findings: string): string {
  return [
    'Codex reviewed your changes and found:',
    '',
    findings,
    '',
    'Fix what is right. If you disagree with a point, leave it and say why in a sentence. Don\'t commit; DevTool lands the task when you are done.'
  ].join('\n')
}

export interface CodexReviewDeps {
  /** The user's `codex` (Settings › AI Tools override, else the login PATH); null when it isn't there. */
  executable(): string | null
  env(): NodeJS.ProcessEnv
  /** Windows: a `.cmd` shim runs through cmd.exe (`conptySpawnArgv`). */
  wrap?(file: string, args: string[]): { file: string; args: string[] }
  log(message: string): void
}

/** Runs one review in `cwd`. Never throws: anything that goes wrong is `failed`. */
export function runCodexReview(cwd: string, prompt: string, deps: CodexReviewDeps, timeoutMs = CODEX_REVIEW_TIMEOUT_MS): Promise<CodexReview> {
  const file = deps.executable()
  if (!file) return Promise.resolve({ status: 'failed', error: 'Codex isn\'t installed (Settings › AI Tools)' })
  let dir: string
  try {
    dir = mkdtempSync(join(tmpdir(), 'devtool-codex-review-'))
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(SCHEMA))
  } catch (err) {
    return Promise.resolve({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
  }
  const outFile = join(dir, 'last-message.txt')
  return new Promise<CodexReview>((resolve) => {
    let settled = false
    let stderr = ''
    const finish = (review: CodexReview): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* a temp dir; the OS sweeps it */ }
      if (review.status === 'failed') deps.log(`codexReview failed cwd=${cwd} error=${review.error}`)
      resolve(review)
    }
    let child: ReturnType<typeof spawn>
    try {
      const args = [
        'exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--color', 'never',
        '--output-schema', join(dir, 'schema.json'), '-o', outFile, '-C', cwd, '-'
      ]
      const argv = deps.wrap ? deps.wrap(file, args) : { file, args }
      child = spawn(argv.file, argv.args, { cwd, env: deps.env(), stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    } catch (err) {
      finish({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ status: 'failed', error: 'Codex took too long' })
    }, timeoutMs)
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
    child.on('error', (err) => finish({ status: 'failed', error: err.message }))
    child.on('close', (code) => {
      let out = ''
      try { out = readFileSync(outFile, 'utf8') } catch { /* no answer written */ }
      if (code !== 0 && !out.trim()) {
        const last = stderr.trim().split('\n').filter(Boolean).pop()
        finish({ status: 'failed', error: `Codex exited with ${code}${last ? `: ${last}` : ''}` })
        return
      }
      finish(parseCodexVerdict(out))
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(prompt)
  })
}

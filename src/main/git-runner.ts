import { execFile } from 'child_process'

/**
 * Runs git for main-side features that need to look at a failure instead of
 * catching it: a rebase that stops on conflicts, an `--ff-only` that git
 * refuses. Local projects get {@link LocalGitRunner}; SSH projects get
 * {@link RemoteGitRunner}, a stub until worktree features reach remote hosts.
 */

export interface GitRunOptions {
  /** Directory git runs in (`cwd`, not `-C`, so relative paths in `args` resolve there). */
  cwd: string
  /** Extra variables on top of the inherited environment. */
  env?: Record<string, string>
  /** Defaults to {@link DEFAULT_GIT_TIMEOUT_MS}. */
  timeoutMs?: number
}

export interface GitResult {
  stdout: string
  stderr: string
  /** Exit code; -1 when git did not run to completion (see `failure`). */
  code: number
  /** Why git did not run to completion: it could not start, it timed out, or the runner can't run git. */
  failure?: 'spawn' | 'timeout' | 'unsupported'
}

export interface GitRunner {
  readonly kind: 'local' | 'remote'
  /** Never rejects: a non-zero exit, a timeout or a missing git all come back as a result. */
  run(args: readonly string[], options: GitRunOptions): Promise<GitResult>
}

export const DEFAULT_GIT_TIMEOUT_MS = 10_000

/** Large enough for `log`/`diff` output; execFile's 1 MB default cuts those off. */
const MAX_BUFFER = 64 * 1024 * 1024

/** git on the local machine, through execFile (no shell). */
export class LocalGitRunner implements GitRunner {
  readonly kind = 'local' as const

  run(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    return new Promise(resolve => {
      execFile('git', [...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : undefined,
        timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true
      }, (err, stdout, stderr) => {
        const out = String(stdout ?? '')
        const errOut = String(stderr ?? '')
        if (!err) {
          resolve({ stdout: out, stderr: errOut, code: 0 })
          return
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null }
        if (typeof e.code === 'number') {
          resolve({ stdout: out, stderr: errOut, code: e.code })
        } else if (e.killed || e.signal) {
          resolve({ stdout: out, stderr: errOut || `git ${args[0] ?? ''} timed out`, code: -1, failure: 'timeout' })
        } else {
          // ENOENT (no git, or cwd gone), maxBuffer exceeded, …
          resolve({ stdout: out, stderr: errOut || e.message, code: -1, failure: 'spawn' })
        }
      })
    })
  }
}

export const REMOTE_GIT_UNSUPPORTED = 'This needs git on the local machine; SSH projects are not supported yet'

/** Placeholder for SSH projects: every call reports `unsupported`. */
export class RemoteGitRunner implements GitRunner {
  readonly kind = 'remote' as const

  async run(): Promise<GitResult> {
    return { stdout: '', stderr: REMOTE_GIT_UNSUPPORTED, code: -1, failure: 'unsupported' }
  }
}

/** A failed git call, for callers that only care whether it worked. `stderr` matches execFile's error shape. */
export class GitError extends Error {
  constructor(readonly args: readonly string[], readonly result: GitResult) {
    super(gitErrorText(args, result))
    this.name = 'GitError'
  }

  get stderr(): string {
    return this.result.stderr
  }
}

/** The one-line reason a call failed: git's own stderr when it said anything. */
export function gitErrorText(args: readonly string[], result: GitResult): string {
  const said = result.stderr.trim() || result.stdout.trim()
  return said || `git ${args.join(' ')} exited with code ${result.code}`
}

/** stdout of a call that must succeed; throws {@link GitError} otherwise. */
export async function gitOutput(runner: GitRunner, args: readonly string[], options: GitRunOptions): Promise<string> {
  const result = await runner.run(args, options)
  if (result.code !== 0) throw new GitError(args, result)
  return result.stdout
}

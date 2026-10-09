import { spawn } from 'child_process'
import type { ChatLoginMethod } from '../../shared/claude-chat'
import type { BashSpawn } from './bash-mode'

/** Past this a sign-in nobody finished is given up on. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000

/** `claude auth login`'s arguments for a method. */
export function loginArgs(method: ChatLoginMethod): string[] {
  if (method === 'console') return ['auth', 'login', '--console']
  if (method === 'sso') return ['auth', 'login', '--sso']
  return ['auth', 'login']
}

/**
 * The sign-in page from `claude auth login`'s output: the one it prints for when
 * the browser didn't open, which ends with a code to paste back.
 */
export function loginUrlFrom(output: string): string | null {
  const match = /https:\/\/\S+/.exec(output)
  return match ? match[0] : null
}

/** "you@example.com (Org)" from `claude auth status --json`, or null when signed out. */
export function accountFromStatus(stdout: string): string | null {
  let status: { loggedIn?: unknown; email?: unknown; orgName?: unknown; authMethod?: unknown }
  try {
    status = JSON.parse(stdout) as typeof status
  } catch {
    return null
  }
  if (!status || status.loggedIn !== true) return null
  const who = typeof status.email === 'string' && status.email ? status.email
    : typeof status.authMethod === 'string' ? status.authMethod : 'your account'
  return typeof status.orgName === 'string' && status.orgName ? `${who} (${status.orgName})` : who
}

/** The last few non-empty lines, for an error message. */
export function outputTail(output: string, lines = 4): string {
  const clean = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  return clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-lines).join('\n')
}

export interface LoginRun {
  /** Send the code the sign-in page showed. */
  submitCode: (code: string) => void
  cancel: () => void
  /** Settles when the CLI exits: ok on exit 0, else what it printed. */
  done: Promise<{ ok: boolean; output: string }>
}

/**
 * Run `claude auth login` with stdin open for a pasted code. Locally the CLI also
 * opens the browser and finishes on its own when the sign-in comes back; over ssh
 * its browser can't open, so the pasted code is the only way through.
 */
export function startLogin(spec: BashSpawn, onOutput: (output: string) => void, timeoutMs = LOGIN_TIMEOUT_MS): LoginRun {
  let output = ''
  let settle!: (result: { ok: boolean; output: string }) => void
  const done = new Promise<{ ok: boolean; output: string }>((resolve) => { settle = resolve })
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (ok: boolean, extra?: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (extra) output += `${output && !output.endsWith('\n') ? '\n' : ''}${extra}`
    settle({ ok, output })
  }

  let child: ReturnType<typeof spawn> | null = null
  try {
    child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env as NodeJS.ProcessEnv | undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (err) {
    finish(false, err instanceof Error ? err.message : String(err))
  }
  if (child) {
    timer = setTimeout(() => {
      child?.kill('SIGTERM')
      finish(false, 'Sign-in timed out.')
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      onOutput(output)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.stdin?.on('error', () => { /* the CLI exited before reading the code */ })
    child.on('error', (err) => finish(false, err.message))
    child.on('close', (code) => finish(code === 0))
  }

  return {
    submitCode: (code) => {
      if (!settled) child?.stdin?.write(`${code.trim()}\n`)
    },
    cancel: () => {
      if (settled) return
      child?.kill('SIGTERM')
      finish(false, 'Cancelled.')
    },
    done
  }
}

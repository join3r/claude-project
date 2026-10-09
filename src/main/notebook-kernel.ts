import { execFile, spawn, type ChildProcessWithoutNullStreams, type ExecFileException, type SpawnOptions } from 'child_process'
import fs from 'fs'
import type { CondaEnvInfo } from '../shared/conda'
import { NotebookExecuteGate, parseNotebookExecuteIpc } from '../shared/notebook-execute'
import {
  NOTEBOOK_ERROR_NO_CONDA,
  NOTEBOOK_ERROR_NO_PYTHON,
  notebookExecuteTooLarge,
  notebookExecuteTooLargeMessage,
  parseKernelEventLine,
  type NotebookKernelEvent
} from '../shared/notebook'
import { ignoreStreamErrors, writeIgnoringBrokenPipe } from './broken-pipe'
import { condaPythonExecutable, type CondaEnvDeps } from './conda-env'
import { getShellEnv, type ShellEnvDeps } from './shell-env'

export type NotebookKernelPrepareOk = {
  ok: true
  python: string
  args: string[]
  env: Record<string, string>
  cwd: string
  helperPath: string
}

export type NotebookKernelPrepareErr = {
  ok: false
  code: 'no-conda' | 'no-python' | 'no-helper'
  error: string
}

export type NotebookKernelPrepareResult = NotebookKernelPrepareOk | NotebookKernelPrepareErr

export interface NotebookKernelPrepareDeps extends CondaEnvDeps, ShellEnvDeps {
  helperExistsSync?: (filePath: string) => boolean
}

/** The bundled jupyter_client helper's file name next to the main bundle (`HostEnv.resourcePath`). */
export const NOTEBOOK_KERNEL_HELPER_RESOURCE = 'notebook-kernel.py'

export function prepareNotebookKernelSpawn(
  condaEnv: CondaEnvInfo | null | undefined,
  cwd: string,
  deps: NotebookKernelPrepareDeps = {},
  helperPath = ''
): NotebookKernelPrepareResult {
  const name = condaEnv?.name?.trim() ?? ''
  const prefix = condaEnv?.prefix?.trim() ?? ''
  if (!name || !prefix) {
    return { ok: false, code: 'no-conda', error: NOTEBOOK_ERROR_NO_CONDA }
  }

  const python = condaPythonExecutable(prefix, deps)
  if (!python) {
    return { ok: false, code: 'no-python', error: NOTEBOOK_ERROR_NO_PYTHON }
  }

  const helperExists = deps.helperExistsSync ?? fs.existsSync
  if (!helperExists(helperPath)) {
    return { ok: false, code: 'no-helper', error: 'Notebook kernel helper is missing from the app install.' }
  }

  const env = {
    ...getShellEnv(deps, { condaEnv }),
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  }

  return {
    ok: true,
    python,
    args: ['-u', helperPath],
    env,
    cwd,
    helperPath
  }
}

export type NotebookKernelListener = (tabId: string, event: NotebookKernelEvent) => void

/** Injected in tests so we can replace a session without a real Python. */
export type NotebookKernelSpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcessWithoutNullStreams

export interface NotebookKernelManagerDeps {
  spawn?: NotebookKernelSpawnFn
  prepare?: typeof prepareNotebookKernelSpawn
  /** The bundled helper script (`HostEnv.resourcePath(NOTEBOOK_KERNEL_HELPER_RESOURCE)`). */
  helperPath?: string
}

interface KernelSession {
  child: ChildProcessWithoutNullStreams
  buffer: string
  kernelPid: number | null
  executeGate: NotebookExecuteGate
}

type KillFn = (pid: number, signal?: NodeJS.Signals | number) => boolean
type ExecFileFn = (
  file: string,
  args: string[],
  callback: (error: ExecFileException | null) => void
) => unknown

/** Exit copy for a helper that already died. Missing-jupyter is only helper exit 2. */
export function deadKernelExitMessage(
  code: number | null,
  signal: NodeJS.Signals | string | null
): string {
  if (signal) return `Kernel exited (${signal}).`
  if (code && code !== 0) return `Kernel exited (code ${code}).`
  return 'Kernel exited.'
}

function tryKill(kill: KillFn, pid: number, signal: NodeJS.Signals | number): void {
  try {
    kill(pid, signal)
  } catch {
    /* already gone */
  }
}

/**
 * Last-resort teardown so ipykernel grandchildren do not orphan.
 * Windows: taskkill /T on helper (and kernel PID if different).
 * POSIX: SIGKILL kernel pid, then the helper process group (`-helperPid`).
 */
export function killProcessTree(
  pids: { helperPid?: number | null; kernelPid?: number | null },
  deps: {
    platform?: NodeJS.Platform
    kill?: KillFn
    execFile?: ExecFileFn
  } = {}
): void {
  const platform = deps.platform ?? process.platform
  const kill = deps.kill ?? process.kill.bind(process)
  const runExecFile = deps.execFile ?? execFile
  const helperPid = pids.helperPid && pids.helperPid > 0 ? pids.helperPid : null
  const kernelPid = pids.kernelPid && pids.kernelPid > 0 ? pids.kernelPid : null

  if (platform === 'win32') {
    const seen = new Set<number>()
    for (const pid of [helperPid, kernelPid]) {
      if (!pid || seen.has(pid)) continue
      seen.add(pid)
      try {
        runExecFile('taskkill', ['/T', '/F', '/PID', String(pid)], () => {
          /* ignore — process may already be gone */
        })
      } catch {
        tryKill(kill, pid, 'SIGKILL')
      }
    }
    return
  }

  if (kernelPid && kernelPid !== helperPid) {
    tryKill(kill, kernelPid, 'SIGKILL')
  }
  if (helperPid) {
    tryKill(kill, -helperPid, 'SIGKILL')
    tryKill(kill, helperPid, 'SIGKILL')
  }
}

/**
 * One jupyter_client helper process per notebook tab.
 * Local conda env only — remote SSH notebooks are out of scope.
 */
export class NotebookKernelManager {
  private sessions = new Map<string, KernelSession>()
  private listener: NotebookKernelListener | null = null
  private readonly spawnFn: NotebookKernelSpawnFn
  private readonly prepareFn: typeof prepareNotebookKernelSpawn
  private readonly helperPath: string

  constructor(deps: NotebookKernelManagerDeps = {}) {
    this.spawnFn =
      deps.spawn ??
      ((command, args, options) => spawn(command, args, options) as ChildProcessWithoutNullStreams)
    this.prepareFn = deps.prepare ?? prepareNotebookKernelSpawn
    this.helperPath = deps.helperPath ?? ''
  }

  onEvent(listener: NotebookKernelListener): void {
    this.listener = listener
  }

  private emit(tabId: string, event: NotebookKernelEvent): void {
    this.listener?.(tabId, event)
  }

  /** Same child-identity guard as exit: ignore a replaced session's I/O. */
  private isActiveKernelChild(tabId: string, child: ChildProcessWithoutNullStreams): boolean {
    return this.sessions.get(tabId)?.child === child
  }

  start(
    tabId: string,
    condaEnv: CondaEnvInfo | null | undefined,
    cwd: string
  ): { error?: string; code?: string } {
    this.shutdown(tabId)
    const prepared = this.prepareFn(condaEnv, cwd, {}, this.helperPath)
    if (!prepared.ok) {
      this.emit(tabId, { event: 'fail', code: prepared.code, message: prepared.error })
      return { error: prepared.error, code: prepared.code }
    }

    this.emit(tabId, { event: 'status', execution_state: 'starting' })

    const child = this.spawnFn(prepared.python, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: new process group so we can kill(-pid) the helper tree.
      // Windows: leave false; taskkill /T is the tree kill.
      detached: process.platform !== 'win32'
    })

    const session: KernelSession = {
      child,
      buffer: '',
      kernelPid: null,
      executeGate: new NotebookExecuteGate()
    }
    this.sessions.set(tabId, session)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    // Async EPIPE/EIO after interrupt/kill is uncaught without these listeners.
    ignoreStreamErrors(child.stdin)
    ignoreStreamErrors(child.stdout)
    ignoreStreamErrors(child.stderr)

    child.stdout.on('data', (chunk: string) => {
      if (!this.isActiveKernelChild(tabId, child)) return
      session.buffer += chunk
      const lines = session.buffer.split('\n')
      session.buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseKernelEventLine(line)
        if (!event) continue
        if (event.event === 'ready' && event.kernel_pid && event.kernel_pid > 0) {
          session.kernelPid = event.kernel_pid
        }
        if (event.event === 'execute_reply') {
          const next = session.executeGate.complete(event.id)
          if (next) this.writeExecute(session, next.requestId, next.code, next.cellId)
        }
        this.emit(tabId, event)
      }
    })

    child.stderr.on('data', (chunk: string) => {
      if (!this.isActiveKernelChild(tabId, child)) return
      const text = chunk.trim()
      if (text) {
        // Keep stderr for debugging; do not surface as cell output.
        // A missing-module traceback still arrives as a fail JSON event on stdout.
      }
    })

    child.on('exit', (code, signal) => {
      if (!this.isActiveKernelChild(tabId, child)) return
      session.executeGate.clear()
      const kernelPid = session.kernelPid
      const helperPid = child.pid ?? null
      this.sessions.delete(tabId)
      // Helper crashed or exited without our shutdown path — still reap ipykernel.
      killProcessTree({ helperPid, kernelPid })
      if (code === 2) {
        // Helper already emitted a fail event for missing jupyter_client / ipykernel.
        this.emit(tabId, { event: 'status', execution_state: 'dead' })
        return
      }
      this.emit(tabId, { event: 'dead', message: deadKernelExitMessage(code, signal) })
      this.emit(tabId, { event: 'status', execution_state: 'dead' })
    })

    child.on('error', (err) => {
      if (!this.isActiveKernelChild(tabId, child)) return
      session.executeGate.clear()
      this.sessions.delete(tabId)
      this.emit(tabId, { event: 'fail', code: 'spawn', message: err.message || 'Could not start Python.' })
      this.emit(tabId, { event: 'status', execution_state: 'dead' })
    })

    return {}
  }

  execute(
    tabId: unknown,
    requestId: unknown,
    code: unknown,
    cellId?: unknown
  ): { error?: string } {
    const parsed = parseNotebookExecuteIpc(tabId, requestId, code, cellId)
    if (!parsed.ok) return { error: parsed.error }
    const { tabId: id, requestId: rid, code: src, cellId: cid } = parsed.value
    if (notebookExecuteTooLarge(src)) {
      return { error: notebookExecuteTooLargeMessage(src.length) }
    }
    const session = this.sessions.get(id)
    if (!session) return { error: 'Kernel is not running. Click Restart kernel.' }
    const action = session.executeGate.submit({
      requestId: rid,
      code: src,
      cellId: cid ?? ''
    })
    if (action === 'start') this.writeExecute(session, rid, src, cid)
    return {}
  }

  interrupt(tabId: string): void {
    const session = this.sessions.get(tabId)
    if (!session) return
    session.executeGate.clear()
    writeIgnoringBrokenPipe(session.child.stdin, `${JSON.stringify({ cmd: 'interrupt' })}\n`)
  }

  shutdown(tabId: string): void {
    const session = this.sessions.get(tabId)
    if (!session) return
    session.executeGate.clear()
    this.sessions.delete(tabId)
    this.forceShutdownSession(session)
  }

  shutdownAll(): void {
    for (const tabId of [...this.sessions.keys()]) {
      this.shutdown(tabId)
    }
  }

  has(tabId: string): boolean {
    return this.sessions.has(tabId)
  }

  private forceShutdownSession(session: KernelSession): void {
    const helperPid = session.child.pid ?? null
    const kernelPid = session.kernelPid
    let settled = false
    const finishKill = (): void => {
      if (settled) return
      settled = true
      killProcessTree({ helperPid, kernelPid })
    }

    writeIgnoringBrokenPipe(session.child.stdin, `${JSON.stringify({ cmd: 'shutdown' })}\n`)

    const timer = setTimeout(finishKill, 2000)
    session.child.once('exit', () => {
      clearTimeout(timer)
      // Helper exited — still kill leftover kernel PID / process group if needed.
      finishKill()
    })
    session.child.once('error', () => {
      clearTimeout(timer)
      finishKill()
    })
  }

  private writeExecute(
    session: KernelSession,
    requestId: string,
    code: string,
    cellId?: string
  ): void {
    writeIgnoringBrokenPipe(
      session.child.stdin,
      `${JSON.stringify({ cmd: 'execute', id: requestId, cellId, code })}\n`
    )
  }
}

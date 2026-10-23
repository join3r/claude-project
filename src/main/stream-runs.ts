import type { ProjectsData, Project, SshConfig, Stream } from '../shared/types'
import { streamDirectory } from '../shared/streams'
import { streamIdOfRunTab, streamRunCommand, streamRunTabId, type StreamRunAction, type StreamRunState } from '../shared/stream-run'
import type { PtySpawnRequest } from './pty-sessions'

/** The part of PtySessions a run uses. */
export interface StreamRunPtys {
  spawnDetached(request: PtySpawnRequest): void
  terminate(id: string): void
  writeFromMain(id: string, data: string): boolean
  isRunning(id: string): boolean
  discard(id: string): void
  loadScrollback(id: string): string | null
}

export interface StreamRunsDeps {
  ptys: StreamRunPtys
  projects: () => ProjectsData
  /** The local shell a run's command goes to (`file -l -c <command>`). */
  localShell: () => string
  /** Waits for an SSH project's connection; throws when it can't be made. */
  ensureSsh: (projectId: string, sshConfig: SshConfig) => Promise<void>
  onState: (projectId: string, streamId: string, state: StreamRunState | null) => void
  log: (message: string) => void
  now?: () => number
  /** How long Stop waits after Ctrl-C before it ends the process outright. */
  graceMs?: number
}

export type StreamRunResult = { ok: true } | { ok: false; error: string }

interface RunEntry {
  projectId: string
  state: StreamRunState
  /** Set while Stop or Restart waits for the process to end. */
  stopping?: { resolve: () => void; timer: ReturnType<typeof setTimeout> }
}

const RUN_COLS = 120
const RUN_ROWS = 32

/**
 * Each stream's app run (`src/shared/stream-run.ts`): start, stop and restart
 * the stream's command in a PTY of its own. One run per stream; a stream that is
 * archived or deleted has its run stopped.
 */
export class StreamRuns {
  private readonly runs = new Map<string, RunEntry>()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number

  constructor(private readonly deps: StreamRunsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** A stream's run as of now; null when it hasn't run since the host started. */
  state(streamId: string): StreamRunState | null {
    return this.runs.get(streamId)?.state ?? null
  }

  /** Every run of one project, by stream id. */
  statesOf(projectId: string): Record<string, StreamRunState> {
    const out: Record<string, StreamRunState> = {}
    for (const [streamId, entry] of this.runs) if (entry.projectId === projectId) out[streamId] = entry.state
    return out
  }

  /** The run's output so far (or the last run's, from disk). */
  logs(streamId: string): string {
    return this.deps.ptys.loadScrollback(streamRunTabId(streamId)) ?? ''
  }

  /** Called after every state change (a phone's inbox follows it). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async control(projectId: string, streamId: string, action: StreamRunAction): Promise<StreamRunResult> {
    if (action === 'stop') {
      await this.stop(streamId)
      return { ok: true }
    }
    if (action === 'restart') await this.stop(streamId)
    else if (this.runs.get(streamId)?.state.status === 'running') return { ok: true }
    return this.start(projectId, streamId)
  }

  /** The PTY exited (PtySessions' `onExit`). */
  handleExit(tabId: string, exitCode: number): void {
    const streamId = streamIdOfRunTab(tabId)
    const entry = streamId ? this.runs.get(streamId) : undefined
    if (!streamId || !entry || entry.state.status !== 'running') return
    const stopping = entry.stopping
    entry.state = stopping
      ? { ...entry.state, status: 'stopped', endedAt: this.now() }
      : { ...entry.state, status: 'exited', exitCode, endedAt: this.now() }
    this.emit(entry.projectId, streamId)
    if (stopping) {
      clearTimeout(stopping.timer)
      entry.stopping = undefined
      stopping.resolve()
    }
  }

  /** Stops runs whose stream (or project) is gone: archived, deleted, or moved off this host. */
  reconcile(): void {
    const live = new Set<string>()
    for (const project of this.deps.projects().projects) {
      for (const stream of project.streams ?? []) live.add(stream.id)
    }
    for (const [streamId, entry] of [...this.runs]) {
      if (live.has(streamId)) continue
      this.deps.log(`streamRun gone stream=${streamId}`)
      this.deps.ptys.discard(streamRunTabId(streamId))
      if (entry.stopping) {
        clearTimeout(entry.stopping.timer)
        entry.stopping.resolve()
      }
      this.runs.delete(streamId)
      this.deps.onState(entry.projectId, streamId, null)
      this.notify()
    }
  }

  private async start(projectId: string, streamId: string): Promise<StreamRunResult> {
    const found = this.find(projectId, streamId)
    if (!found) return { ok: false, error: 'The stream is gone' }
    const { project, stream } = found
    const command = streamRunCommand(project, stream)
    if (!command) return { ok: false, error: 'No run command is set for this project or stream' }
    const cwd = streamDirectory(project, stream)
    const id = streamRunTabId(streamId)
    const request: PtySpawnRequest = project.ssh
      ? { id, shell: '/bin/sh', args: ['-c', command], cwd, cols: RUN_COLS, rows: RUN_ROWS, projectId, sshConfig: project.ssh, quiet: true }
      : { id, shell: this.deps.localShell(), args: ['-l', '-c', command], cwd, cols: RUN_COLS, rows: RUN_ROWS, projectId, quiet: true }
    try {
      if (project.ssh) await this.deps.ensureSsh(projectId, project.ssh)
      this.deps.ptys.spawnDetached(request)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    this.deps.log(`streamRun start stream=${streamId} cwd=${cwd}`)
    this.runs.set(streamId, { projectId, state: { status: 'running', command, startedAt: this.now() } })
    this.emit(projectId, streamId)
    return { ok: true }
  }

  /** Ctrl-C first, so a dev server can clean up; the process is ended outright after the grace period. */
  private stop(streamId: string): Promise<void> {
    const entry = this.runs.get(streamId)
    const id = streamRunTabId(streamId)
    if (!entry || entry.state.status !== 'running' || !this.deps.ptys.isRunning(id)) return Promise.resolve()
    if (entry.stopping) return new Promise(resolve => { this.whenStopped(entry, resolve) })
    this.deps.log(`streamRun stop stream=${streamId}`)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.deps.ptys.terminate(id)
        // An end that never reports its exit still counts as stopped.
        setTimeout(() => { if (entry.stopping) this.handleExit(id, -1) }, 1000)
      }, this.deps.graceMs ?? 3000)
      entry.stopping = { resolve, timer }
      if (!this.deps.ptys.writeFromMain(id, '\x03')) this.deps.ptys.terminate(id)
    })
  }

  private whenStopped(entry: RunEntry, resolve: () => void): void {
    const stopping = entry.stopping
    if (!stopping) { resolve(); return }
    const previous = stopping.resolve
    stopping.resolve = () => { previous(); resolve() }
  }

  private find(projectId: string, streamId: string): { project: Project; stream: Stream } | null {
    const project = this.deps.projects().projects.find(p => p.id === projectId)
    const stream = project?.streams?.find(s => s.id === streamId)
    return project && stream ? { project, stream } : null
  }

  private emit(projectId: string, streamId: string): void {
    this.deps.onState(projectId, streamId, this.state(streamId))
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

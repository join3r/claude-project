import type { ProjectsData, Project, SshConfig, Stream, Task } from '../shared/types'
import { streamDirectory, taskDirectory } from '../shared/streams'
import {
  findStreamRunCommand, parseStreamRunTabId, streamRunKey, streamRunTabId,
  type StreamRunAction, type StreamRunState
} from '../shared/stream-run'
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
  /** A run changed; null once it is gone. */
  onState: (projectId: string, streamId: string, commandId: string, state: StreamRunState | null) => void
  log: (message: string) => void
  now?: () => number
  /** How long Stop waits after Ctrl-C before it ends the process outright. */
  graceMs?: number
}

export type StreamRunResult = { ok: true } | { ok: false; error: string }

interface RunEntry {
  projectId: string
  streamId: string
  state: StreamRunState
  /** Set while Stop or Restart waits for the process to end. */
  stopping?: { resolve: () => void; timer: ReturnType<typeof setTimeout> }
}

const RUN_COLS = 120
const RUN_ROWS = 32

/**
 * Each stream's command runs (`src/shared/stream-run.ts`): start, stop and
 * restart one of a stream's commands in a PTY of its own, in the stream's folder
 * or a task's worktree. One run per stream and command; a stream that is archived
 * or deleted, or a task whose worktree a run is in that closes, has its runs
 * stopped.
 */
export class StreamRuns {
  /** By {@link streamRunKey}. */
  private readonly runs = new Map<string, RunEntry>()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number

  constructor(private readonly deps: StreamRunsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** A command's run as of now; null when it hasn't run since the host started. */
  state(streamId: string, commandId: string): StreamRunState | null {
    return this.runs.get(streamRunKey(streamId, commandId))?.state ?? null
  }

  /** Every run of one stream, in the order they first ran. */
  statesOfStream(streamId: string): StreamRunState[] {
    return [...this.runs.values()].filter(entry => entry.streamId === streamId).map(entry => entry.state)
  }

  /** Every run of one project, by {@link streamRunKey}. */
  statesOf(projectId: string): Record<string, StreamRunState> {
    const out: Record<string, StreamRunState> = {}
    for (const [key, entry] of this.runs) if (entry.projectId === projectId) out[key] = entry.state
    return out
  }

  /** The run's output so far (or the last run's, from disk). */
  logs(streamId: string, commandId: string): string {
    return this.deps.ptys.loadScrollback(streamRunTabId(streamId, commandId)) ?? ''
  }

  /** Called after every state change (a phone's inbox follows it). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * `taskId` runs the command in that task's worktree. Start with it while the
   * command runs somewhere else moves the run there; Restart without it keeps the
   * run where it was, Start without it runs in the stream's folder.
   */
  async control(projectId: string, streamId: string, commandId: string, action: StreamRunAction, taskId?: string): Promise<StreamRunResult> {
    const key = streamRunKey(streamId, commandId)
    if (action === 'stop') {
      await this.stop(key)
      return { ok: true }
    }
    const current = this.runs.get(key)?.state
    if (action === 'restart') {
      await this.stop(key)
      return this.start(projectId, streamId, commandId, taskId ?? current?.taskId)
    }
    if (current?.status === 'running') {
      if (current.taskId === taskId) return { ok: true }
      await this.stop(key)
    }
    return this.start(projectId, streamId, commandId, taskId)
  }

  /** The PTY exited (PtySessions' `onExit`). */
  handleExit(tabId: string, exitCode: number): void {
    const parsed = parseStreamRunTabId(tabId)
    const key = parsed ? streamRunKey(parsed.streamId, parsed.commandId) : null
    const entry = key ? this.runs.get(key) : undefined
    if (!entry || entry.state.status !== 'running') return
    const stopping = entry.stopping
    entry.state = stopping
      ? { ...entry.state, status: 'stopped', endedAt: this.now() }
      : { ...entry.state, status: 'exited', exitCode, endedAt: this.now() }
    this.emit(entry)
    if (stopping) {
      clearTimeout(stopping.timer)
      entry.stopping = undefined
      stopping.resolve()
    }
  }

  /**
   * Stops runs whose stream (or project) is gone: archived, deleted, or moved off
   * this host; and runs in a task's worktree once the task left the stream (closed,
   * so its worktree goes too). A run whose command was removed keeps going.
   */
  reconcile(): void {
    const live = new Map<string, Set<string>>()
    for (const project of this.deps.projects().projects) {
      for (const stream of project.streams ?? []) live.set(stream.id, new Set(stream.tasks.map(task => task.id)))
    }
    for (const [key, entry] of [...this.runs]) {
      const tasks = live.get(entry.streamId)
      const taskId = entry.state.taskId
      if (tasks && (!taskId || tasks.has(taskId))) continue
      this.deps.log(`streamRun gone stream=${entry.streamId} command=${entry.state.commandId}${taskId ? ` task=${taskId}` : ''}`)
      this.deps.ptys.discard(streamRunTabId(entry.streamId, entry.state.commandId))
      if (entry.stopping) {
        clearTimeout(entry.stopping.timer)
        entry.stopping.resolve()
      }
      this.runs.delete(key)
      this.deps.onState(entry.projectId, entry.streamId, entry.state.commandId, null)
      this.notify()
    }
  }

  private async start(projectId: string, streamId: string, commandId: string, taskId: string | undefined): Promise<StreamRunResult> {
    const found = this.find(projectId, streamId)
    if (!found) return { ok: false, error: 'The stream is gone' }
    const { project, stream } = found
    const runCommand = findStreamRunCommand(project, stream, commandId)
    if (!runCommand) return { ok: false, error: 'That command is no longer set for this project or stream' }
    let task: Task | undefined
    if (taskId) {
      task = stream.tasks.find(t => t.id === taskId)
      if (!task) return { ok: false, error: 'The task is gone' }
      // A task without a worktree of its own works in the stream's folder.
      if (!task.workspace) task = undefined
    }
    const cwd = task ? taskDirectory(project, task) : streamDirectory(project, stream)
    const id = streamRunTabId(streamId, commandId)
    const { command } = runCommand
    const request: PtySpawnRequest = project.ssh
      ? { id, shell: '/bin/sh', args: ['-c', command], cwd, cols: RUN_COLS, rows: RUN_ROWS, projectId, sshConfig: project.ssh, quiet: true }
      : { id, shell: this.deps.localShell(), args: ['-l', '-c', command], cwd, cols: RUN_COLS, rows: RUN_ROWS, projectId, quiet: true }
    try {
      if (project.ssh) await this.deps.ensureSsh(projectId, project.ssh)
      this.deps.ptys.spawnDetached(request)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    this.deps.log(`streamRun start stream=${streamId} command=${commandId}${task ? ` task=${task.id}` : ''} cwd=${cwd}`)
    const entry: RunEntry = {
      projectId,
      streamId,
      state: { status: 'running', commandId, name: runCommand.name, command, startedAt: this.now(), ...(task ? { taskId: task.id } : {}) }
    }
    // A run that ran before keeps its place in the stream's order.
    this.runs.set(streamRunKey(streamId, commandId), entry)
    this.emit(entry)
    return { ok: true }
  }

  /** Ctrl-C first, so a dev server can clean up; the process is ended outright after the grace period. */
  private stop(key: string): Promise<void> {
    const entry = this.runs.get(key)
    if (!entry) return Promise.resolve()
    const id = streamRunTabId(entry.streamId, entry.state.commandId)
    if (entry.state.status !== 'running' || !this.deps.ptys.isRunning(id)) return Promise.resolve()
    if (entry.stopping) return new Promise(resolve => { this.whenStopped(entry, resolve) })
    this.deps.log(`streamRun stop stream=${entry.streamId} command=${entry.state.commandId}`)
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

  private emit(entry: RunEntry): void {
    this.deps.onState(entry.projectId, entry.streamId, entry.state.commandId, entry.state)
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

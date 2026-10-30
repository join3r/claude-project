import { isShellCommandProject, type Project, type RunCommand, type Stream, type Task } from './types'

/**
 * A stream's app runs: named commands (the project's list, plus the stream's own,
 * which add commands or replace one of the project's by name), each started in
 * the stream's folder or in the worktree of one of its tasks, in a PTY of its own
 * that no task owns. Each command has its own run, so `install` can run while
 * nothing else does, or `run` and `run (staging)` side by side. A run's output is
 * its log, viewed on demand.
 */

/** `running` until the process ends; `stopped` when Stop (or Restart) ended it, `exited` when it ended by itself. */
export type StreamRunStatus = 'running' | 'exited' | 'stopped'

export interface StreamRunState {
  status: StreamRunStatus
  /** The {@link RunCommand} this run is of. */
  commandId: string
  /** The command's name when it started. */
  name: string
  /** The command line this run started with. */
  command: string
  startedAt: number
  endedAt?: number
  /** The process's exit code, once it has `exited`. */
  exitCode?: number
  /** The task whose worktree it runs in; absent when it runs in the stream's folder. */
  taskId?: string
}

export type StreamRunAction = 'start' | 'stop' | 'restart'
export const STREAM_RUN_ACTIONS: readonly StreamRunAction[] = ['start', 'stop', 'restart']

/** The id the single `runCommand` of older data gets as a {@link RunCommand}. */
export const LEGACY_RUN_COMMAND_ID = 'run'

/** One run's key among a host's runs: its stream and command. */
export function streamRunKey(streamId: string, commandId: string): string {
  return `${streamId}~${commandId}`
}

/** The PTY id of a command's run (no colon: tab ids may not hold `:`). */
export function streamRunTabId(streamId: string, commandId: string): string {
  return `run-${streamRunKey(streamId, commandId)}`
}

/** The stream and command a run PTY id belongs to, or null when it isn't one. */
export function parseStreamRunTabId(tabId: string): { streamId: string; commandId: string } | null {
  return tabId.startsWith('run-') ? parseStreamRunKey(tabId.slice(4)) : null
}

/** The stream and command of a {@link streamRunKey}. */
export function parseStreamRunKey(key: string): { streamId: string; commandId: string } | null {
  const cut = key.lastIndexOf('~')
  if (cut <= 0 || cut === key.length - 1) return null
  return { streamId: key.slice(0, cut), commandId: key.slice(cut + 1) }
}

/** A fresh id for a new {@link RunCommand}. */
export function newRunCommandId(): string {
  return `c${Math.random().toString(36).slice(2, 10)}`
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function clean(list: readonly RunCommand[] | undefined): RunCommand[] {
  return (list ?? [])
    .map(c => ({ id: c.id, name: c.name.trim(), command: c.command.trim() }))
    .filter(c => c.id && c.name && c.command)
}

/** The project's own commands; older data's single `runCommand` reads as one named `run`. */
export function projectRunCommands(project: Project): RunCommand[] {
  if (project.runCommands) return clean(project.runCommands)
  const legacy = project.runCommand?.trim()
  return legacy ? [{ id: LEGACY_RUN_COMMAND_ID, name: 'run', command: legacy }] : []
}

/**
 * The stream's own commands. Older data's single `runCommand` took the place of
 * the project's command, so it reads as an override of the project's first one.
 */
export function streamOwnRunCommands(project: Project, stream: Stream | undefined): RunCommand[] {
  if (!stream) return []
  if (stream.runCommands) return clean(stream.runCommands)
  const legacy = stream.runCommand?.trim()
  if (!legacy) return []
  const first = projectRunCommands(project)[0]
  return [{ id: first?.id ?? LEGACY_RUN_COMMAND_ID, name: first?.name ?? 'run', command: legacy }]
}

/**
 * The commands a stream runs, in order: the project's, each replaced by the
 * stream's command of the same name (keeping the project's id and place), then
 * the stream's others. None on a shell-command project.
 */
export function streamRunCommands(project: Project, stream: Stream | undefined): RunCommand[] {
  if (isShellCommandProject(project)) return []
  const own = streamOwnRunCommands(project, stream)
  const used = new Set<RunCommand>()
  const out = projectRunCommands(project).map(command => {
    const override = own.find(c => sameName(c.name, command.name))
    if (!override) return command
    used.add(override)
    return { ...command, command: override.command }
  })
  for (const command of own) if (!used.has(command)) out.push(command)
  return out
}

/** The project with `commands` as its own list (none: cleared); older data's single `runCommand` goes with it. */
export function withProjectRunCommands(project: Project, commands: RunCommand[]): Project {
  const { runCommand: _old, runCommands: _list, ...rest } = project
  return commands.length > 0 ? { ...rest, runCommands: commands } : rest
}

/** The stream with `commands` as its own list (none: cleared); older data's single `runCommand` goes with it. */
export function withStreamRunCommands(stream: Stream, commands: RunCommand[]): Stream {
  const { runCommand: _old, runCommands: _list, ...rest } = stream
  return commands.length > 0 ? { ...rest, runCommands: commands } : rest
}

/** One of the stream's commands by id. */
export function findStreamRunCommand(project: Project, stream: Stream | undefined, commandId: string): RunCommand | undefined {
  return streamRunCommands(project, stream).find(c => c.id === commandId)
}

/** The task has a worktree of its own its stream's commands can run in. */
export function canRunAppInTask(project: Project, stream: Stream | undefined, task: Task): boolean {
  return !!task.workspace && streamRunCommands(project, stream).length > 0
}

/** The task whose worktree the run is in; undefined when it runs in the stream's folder (or the task is gone). */
export function streamRunTask(stream: Stream | undefined, run: StreamRunState | undefined): Task | undefined {
  return run?.taskId ? stream?.tasks.find(task => task.id === run.taskId) : undefined
}

/** The runs of one stream among `all` (by {@link streamRunKey}), in the order they first ran. */
export function runsOfStream(all: Readonly<Record<string, StreamRunState>>, streamId: string): StreamRunState[] {
  const out: StreamRunState[] = []
  for (const [key, run] of Object.entries(all)) {
    if (parseStreamRunKey(key)?.streamId === streamId) out.push(run)
  }
  return out
}

/** A crashed run's key in the Inbox's dismissed set: its command run and when it started. */
export function streamRunCrashKey(streamId: string, run: StreamRunState): string {
  return `${streamRunKey(streamId, run.commandId)}:${run.startedAt}`
}

/** A run that belongs in a badge or the Inbox's Apps: running, or ended by itself with a non-zero code. */
export function streamRunCrashed(run: StreamRunState): boolean {
  return run.status === 'exited' && run.exitCode !== 0
}

/**
 * A run's log as plain text (the phone's `stream.logs`): terminal escapes removed,
 * and a line redrawn with `\r` (a progress bar) kept as it was last drawn.
 */
export function plainRunLog(scrollback: string): string {
  const text = scrollback
    // OSC (titles, links): ESC ] … BEL or ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI (colors, cursor moves): ESC [ params final
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Charset picks (ESC ( B), then any other two-byte escape (keypad modes).
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '')
    .replace(/\x1b[@-_=>]?/g, '')
    .replace(/\r+\n/g, '\n')
  return text
    .split('\n')
    .map(line => {
      const cut = line.lastIndexOf('\r', line.length - 2)
      return (cut >= 0 ? line.slice(cut + 1) : line).replace(/\r$/, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    })
    .join('\n')
}

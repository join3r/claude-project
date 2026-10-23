import { isShellCommandProject, type Project, type Stream } from './types'

/**
 * A stream's app run: one command (the stream's own `runCommand`, else the
 * project's) started in the stream's folder, in a PTY of its own that no task
 * owns. Its output is the run's log, viewed on demand.
 */

/** `running` until the process ends; `stopped` when Stop (or Restart) ended it, `exited` when it ended by itself. */
export type StreamRunStatus = 'running' | 'exited' | 'stopped'

export interface StreamRunState {
  status: StreamRunStatus
  /** The command this run started with. */
  command: string
  startedAt: number
  endedAt?: number
  /** The process's exit code, once it has `exited`. */
  exitCode?: number
}

export type StreamRunAction = 'start' | 'stop' | 'restart'
export const STREAM_RUN_ACTIONS: readonly StreamRunAction[] = ['start', 'stop', 'restart']

/** The PTY id of a stream's run (dash, not colon: tab ids may not hold `:`). */
export function streamRunTabId(streamId: string): string {
  return `run-${streamId}`
}

/** The stream a run PTY id belongs to, or null when it isn't one. */
export function streamIdOfRunTab(tabId: string): string | null {
  return tabId.startsWith('run-') && tabId.length > 4 ? tabId.slice(4) : null
}

/** The command a stream runs: its own, else the project's; undefined when neither is set (or the project has no folder). */
export function streamRunCommand(project: Project, stream: Stream | undefined): string | undefined {
  if (isShellCommandProject(project)) return undefined
  const own = stream?.runCommand?.trim()
  if (own) return own
  return project.runCommand?.trim() || undefined
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

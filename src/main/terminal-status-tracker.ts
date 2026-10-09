import { hasBell, terminalStatusFromOutput } from '../shared/terminal-status'
import type { TabStatusValue } from '../shared/types'

/** How often a chunk may change a tab's status (bells always may). */
const STATUS_THROTTLE_MS = 200
/** A 'working' tab that printed nothing for this long is idle again. */
const QUIET_MS = 30_000

export interface TerminalStatusTrackerDeps {
  /** The tab's status as the host has it (TabActivityRegistry). */
  getStatus: (tabId: string) => TabStatusValue
  /** A new status for the tab (`TabActivityRegistry.reported`). */
  report: (tabId: string, status: TabStatusValue) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * The terminal status heuristics (shared/terminal-status.ts, the same ones a
 * window runs in TerminalTab) on the host, from PTY output: for tabs no hook
 * reports on (shells, Codex). A DevTool server runs these, so a tab's status
 * exists with no window attached (its sleep blocker, its phones, the update
 * that waits for idle); a desktop keeps its windows' verdicts instead.
 */
export class TerminalStatusTracker {
  private readonly lastChange = new Map<string, number>()
  private readonly quietTimers = new Map<string, unknown>()
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: TerminalStatusTrackerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    })
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  /** A chunk of the tab's PTY output. */
  output(tabId: string, chunk: string): void {
    const now = this.now()
    if (!hasBell(chunk) && now - (this.lastChange.get(tabId) ?? -Infinity) < STATUS_THROTTLE_MS) return
    this.lastChange.set(tabId, now)

    const prev = this.deps.getStatus(tabId)
    if (prev === 'exited') return
    const next = terminalStatusFromOutput(chunk, prev)
    if (next !== prev) this.deps.report(tabId, next)

    const pending = this.quietTimers.get(tabId)
    if (pending !== undefined) this.clearTimer(pending)
    this.quietTimers.set(tabId, this.setTimer(() => {
      this.quietTimers.delete(tabId)
      if (this.deps.getStatus(tabId) === 'working') this.deps.report(tabId, null)
    }, QUIET_MS))
  }

  /** The tab's process ended or was replaced: its timers go. */
  forget(tabId: string): void {
    const pending = this.quietTimers.get(tabId)
    if (pending !== undefined) this.clearTimer(pending)
    this.quietTimers.delete(tabId)
    this.lastChange.delete(tabId)
  }
}

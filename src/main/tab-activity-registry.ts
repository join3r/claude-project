import { classifyNotification, nextAiStatus, type AiStatusEvent } from '../shared/ai-status'
import { reduceAgentActivity, type ActivityUpdate, type AgentActivity } from '../shared/agent-activity'
import type { TabStatusValue } from '../shared/types'

/**
 * Main's copy of "what is this tab's process doing right now".
 *
 * A window's `TabStatusContext` is per-window by construction, so it is blind to a
 * task running in another window. Main receives every hook
 * event and owns every PTY, so this is the only complete picture there is.
 *
 * The transitions come from `shared/ai-status.ts`, the same state machine
 * `AiToolTab` drives, so the two cannot disagree about what "working" means.
 * Hook and process events feed it directly. The renderer-only heuristics (terminal
 * bell, PTY-quiet) have no equivalent here, so for tabs without hooks the window
 * that mounts them reports its verdict (`reported`) — and a window may not be
 * open.
 */
export class TabActivityRegistry {
  private readonly statuses = new Map<string, TabStatusValue>()
  private readonly since = new Map<string, number>()
  /** The "what is it doing" side (shared/agent-activity.ts), fed by every Claude hook body. */
  private readonly activities = new Map<string, AgentActivity>()
  private readonly listeners = new Set<(tabId: string) => void>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Called after anything about `tabId` changed (status, since or activity). For
   * main-side consumers that are not windows (the mobile inbox); the windows keep
   * getting their own broadcasts from AppRuntime.
   */
  subscribe(listener: (tabId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(tabId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(tabId)
      } catch {
        // A consumer's failure must not break hook handling.
      }
    }
  }

  /** Claude's UserPromptSubmit / pi's agent_start. */
  working(tabId: string): void {
    this.apply(tabId, (current) => nextAiStatus(current, 'hook-working', this.context()))
  }

  /**
   * Claude's Stop hook — authoritative "the turn is done". The agent is done too
   * unless it left background tasks running.
   */
  stopped(tabId: string): void {
    const ctx = { ...this.context(), backgroundTasks: this.backgroundTasks(tabId) }
    this.apply(tabId, (current) => nextAiStatus(current, 'hook-stopped', ctx))
  }

  /** Live background tasks the tab's agent reported, 0 when none or unknown. */
  backgroundTasks(tabId: string): number {
    return this.activities.get(tabId)?.background ?? 0
  }

  /**
   * Claude's Notification hook / pi's agent_end. The renderer suppresses the idle
   * nudge while you are looking at the tab; main has no window to ask, so it takes
   * the protective reading — and a tab you are actually looking at belongs to a
   * task the open-in-any-window safeguard already exempts.
   */
  notification(tabId: string, body?: Record<string, unknown>): void {
    const notificationKind = classifyNotification(body)
    this.apply(tabId, (current) => nextAiStatus(current, 'hook-notification', this.context(notificationKind)))
  }

  /**
   * A status event implied by an `activity` hook (permission dialog, question,
   * API failure, answered prompt) — see `reduceAgentActivity`.
   */
  statusEvent(tabId: string, event: AiStatusEvent): void {
    this.apply(tabId, (current) => nextAiStatus(current, event, this.context()))
  }

  /**
   * Fold a hook body into the tab's activity. Returns null when nothing changed,
   * so callers only broadcast real updates.
   */
  applyHook(tabId: string, body: Record<string, unknown> | undefined): ActivityUpdate | null {
    const prev = this.activities.get(tabId)
    const update = reduceAgentActivity(prev, body, this.now())
    if (!update.changed) return null
    this.activities.set(tabId, update.activity)
    this.changed(tabId)
    return update
  }

  getActivity(tabId: string): AgentActivity | null {
    return this.activities.get(tabId) ?? null
  }

  getActivitySnapshot(): Record<string, AgentActivity> {
    return Object.fromEntries(this.activities)
  }

  /**
   * A status a window derived for a tab no hook reports on (Codex, shells: PTY
   * output, the terminal bell, going quiet). The window is the only one that can
   * see those signals, so its verdict is taken as is — except over 'exited', which
   * only a respawn (`reset`) or another exit may rewrite.
   */
  reported(tabId: string, status: TabStatusValue): void {
    this.apply(tabId, (current) => (current === 'exited' && status !== 'exited' ? 'keep' : status))
  }

  /**
   * The window that reported for this tab is gone, and with it the only source of
   * its heuristics: keep 'exited', forget a 'working' or 'attention' nobody will
   * ever clear.
   */
  unreported(tabId: string): void {
    this.apply(tabId, (current) => (current === 'exited' ? 'keep' : null))
  }

  /** A session started in this tab: it exists, but nothing is claimed about its status. */
  touch(tabId: string): void {
    if (this.statuses.has(tabId)) return
    this.statuses.set(tabId, null)
    this.since.set(tabId, this.now())
    this.changed(tabId)
  }

  /** The PTY exited. Terminal until the tab respawns — and not a protective status. */
  exited(tabId: string): void {
    this.apply(tabId, (current) => nextAiStatus(current, 'exit', this.context()))
    if (this.endTurn(tabId)) this.changed(tabId)
  }

  /** A fresh process for the same tab id — the old status describes a dead one. */
  reset(tabId: string): void {
    this.statuses.set(tabId, null)
    this.since.set(tabId, this.now())
    this.endTurn(tabId)
    this.changed(tabId)
  }

  /**
   * Keep what the conversation was about (a resume continues it); drop anything
   * that described the dead process's in-flight turn.
   */
  private endTurn(tabId: string): boolean {
    const activity = this.activities.get(tabId)
    if (!activity) return false
    this.activities.set(tabId, {
      ...activity,
      tool: undefined,
      waiting: undefined,
      subagents: 0,
      background: undefined,
      compacting: false,
      turnStartedAt: undefined,
      updatedAt: this.now()
    })
    return true
  }

  /** The tab is gone (removed, or its task deleted). */
  remove(tabId: string): void {
    const known = this.statuses.has(tabId) || this.activities.has(tabId)
    this.statuses.delete(tabId)
    this.since.delete(tabId)
    this.activities.delete(tabId)
    if (known) this.changed(tabId)
  }

  getStatus(tabId: string): TabStatusValue {
    return this.statuses.get(tabId) ?? null
  }

  getSnapshot(): Record<string, TabStatusValue> {
    return Object.fromEntries(this.statuses)
  }

  /** When the tab's current status began (epoch ms), or null when main has never heard of it. */
  getSince(tabId: string): number | null {
    return this.since.get(tabId) ?? null
  }

  getSinceSnapshot(): Record<string, number> {
    return Object.fromEntries(this.since)
  }

  private context(notificationKind?: ReturnType<typeof classifyNotification>) {
    // No window context to consult: `visible`/`windowFocused` are the renderer's
    // suppression inputs, and main deliberately never suppresses.
    return { isHookTab: true, visible: false, windowFocused: false, notificationKind }
  }

  private apply(tabId: string, decide: (current: TabStatusValue) => TabStatusValue | 'keep'): void {
    const current = this.statuses.get(tabId) ?? null
    const decision = decide(current)
    if (decision === 'keep') {
      this.touch(tabId)
      return
    }
    if (this.statuses.has(tabId) && current === decision) return
    this.statuses.set(tabId, decision)
    this.since.set(tabId, this.now())
    this.changed(tabId)
  }
}

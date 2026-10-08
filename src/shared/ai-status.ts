import type { TabStatusValue } from './types'

/**
 * The status dot for an AI tab is written from four independent sources (Claude/pi
 * hooks, raw PTY activity, the terminal bell, PTY exit). This module is the single
 * place that decides what wins, so the rules are testable instead of buried in
 * AiToolTab's effects.
 *
 * It is shared rather than renderer-local because main runs the same state machine
 * over the hook events it forwards (`src/main/tab-activity-registry.ts`); idle
 * cleanup would otherwise be deciding "is this agent busy?" by its own rules.
 */

export type AiStatusEvent =
  /** A chunk of PTY output arrived. */
  | 'pty-data'
  /** No PTY output for QUIET_MS — the tab settled down. */
  | 'pty-quiet'
  /** No PTY output for STALE_WORKING_MS while still 'working' — Stop is never coming. */
  | 'stale-working'
  /** Claude's UserPromptSubmit hook / pi's agent_start. */
  | 'hook-working'
  /** Claude's Stop hook. */
  | 'hook-stopped'
  /** A background agent or workflow went live while no turn was running. */
  | 'background-started'
  /** The last background task ended and no turn picked up after it. */
  | 'background-done'
  /** Claude's Notification hook / pi's agent_end. */
  | 'hook-notification'
  /**
   * Claude is blocked on you for something it can't proceed without: a permission
   * dialog (PermissionRequest), a question or plan approval (AskUserQuestion /
   * ExitPlanMode), or a turn that died on an API error (StopFailure).
   */
  | 'hook-needs-input'
  /** The tool call Claude was blocked on has resolved — you answered it. */
  | 'hook-input-resolved'
  /** Terminal bell (non-hook tools only). */
  | 'bell'
  /** The tab became visible. */
  | 'visit'
  /** The PTY exited. */
  | 'exit'

/**
 * - permission: blocked on you (permission, elicitation, "agent needs input").
 * - idle: the 60s "still waiting" nudge that follows every Stop.
 * - info: informational only (login succeeded, an elicitation completed).
 * - resumed: Claude picked the turn back up on its own (usage limit reset).
 */
export type AiNotificationKind = 'permission' | 'idle' | 'info' | 'resumed' | 'unknown'

export interface AiStatusCtx {
  /** Claude/pi: status comes from hooks, so silence carries no meaning. */
  isHookTab: boolean
  visible: boolean
  windowFocused: boolean
  notificationKind?: AiNotificationKind
  /** Live background agents and workflows the agent left running past its turn. */
  backgroundTasks?: number
}

/** 'keep' means "leave the status alone" — distinct from setting it to null. */
export type AiStatusDecision = TabStatusValue | 'keep'

/**
 * Claude Code sends a structured `notification_type` (matcher values in the hooks
 * docs). It is authoritative when present; the message regexes below only cover
 * older Claude builds and anything that posts a bare message.
 */
const NOTIFICATION_TYPES: Record<string, AiNotificationKind> = {
  permission_prompt: 'permission',
  elicitation_dialog: 'permission',
  elicitation_url_dialog: 'permission',
  agent_needs_input: 'permission',
  idle_prompt: 'idle',
  auth_success: 'info',
  elicitation_complete: 'info',
  elicitation_response: 'info',
  agent_completed: 'info',
  quota_auto_resume_stale: 'info',
  quota_auto_resume_disabled: 'info',
  quota_auto_resume_fired: 'resumed'
}

/**
 * Message fallback. Order matters (first match wins), so permission patterns come
 * first. Adding a newly observed string is one line here.
 */
const NOTIFICATION_PATTERNS: { kind: AiNotificationKind; re: RegExp }[] = [
  { kind: 'permission', re: /needs? your permission/i },
  { kind: 'permission', re: /permission to use/i },
  { kind: 'permission', re: /\bapprov(e|al)\b/i },
  { kind: 'idle', re: /waiting for your input/i },
  { kind: 'idle', re: /\bidle\b/i },
  { kind: 'info', re: /login successful/i },
  { kind: 'resumed', re: /continuing your task/i }
]

/**
 * Anything we can't place is 'unknown' and gets treated as attention downstream:
 * a false "needs you" is cheap, a missed permission prompt blocks the agent
 * silently. Log the raw message (see statusDebug) to tighten this over time.
 */
export function classifyNotification(body: Record<string, unknown> | undefined): AiNotificationKind {
  const type = typeof body?.notification_type === 'string' ? body.notification_type : ''
  if (type && NOTIFICATION_TYPES[type]) return NOTIFICATION_TYPES[type]
  const message = typeof body?.message === 'string' ? body.message : ''
  for (const { kind, re } of NOTIFICATION_PATTERNS) {
    if (re.test(message)) return kind
  }
  return 'unknown'
}

export function nextAiStatus(
  current: TabStatusValue,
  event: AiStatusEvent,
  ctx: AiStatusCtx
): AiStatusDecision {
  // 'exited' is terminal: the process is gone, so nothing it "said" earlier and no
  // heuristic may paint over it. Only a fresh exit event rewrites it (respawns
  // clear it explicitly).
  if (current === 'exited' && event !== 'exit') return 'keep'

  switch (event) {
    case 'pty-data':
      // Output is evidence of activity, never of a question — and it must not stomp
      // an 'attention' that a hook (or bell) asked for.
      return current === 'attention' ? 'keep' : 'working'

    case 'pty-quiet':
      // "The tab isn't on screen and went quiet" is not evidence that an agent needs
      // you: it fires on scrollback replay, TUI redraws, status lines and the echo of
      // your own typing. Hook tabs have Stop for "done", so quiet tells them nothing.
      // Bell-less tools (Codex) have no other "the agent stopped" signal, so they keep it.
      if (ctx.isHookTab) return 'keep'
      if (current !== 'working') return 'keep'
      return ctx.visible ? null : 'attention'

    case 'stale-working':
      // Watchdog: a hook tab stuck 'working' long after its last output means Stop is
      // never arriving (crash, /clear, killed session, dropped SSH, hooks not installed).
      return current === 'working' ? null : 'keep'

    case 'hook-working':
      return 'working'

    case 'hook-stopped':
      // The Stop hook is the authoritative "the agent is done"; it must be able to
      // clear an 'attention' a heuristic guessed while the agent was still running.
      // A turn that ends with background agents or workflows still running isn't done:
      // Claude picks the turn back up when they finish.
      return (ctx.backgroundTasks ?? 0) > 0 ? 'working' : null

    case 'background-started':
      return current === null ? 'working' : 'keep'

    case 'background-done':
      // Only what the background work held up: an attention or exit stays.
      return current === 'working' ? null : 'keep'

    case 'hook-notification':
      switch (ctx.notificationKind) {
        case 'idle':
          // Claude sends this 60s after every Stop. Stop already said "done" and marked
          // the task unread, so treating the nudge as attention is what dragged settled
          // tasks back into "Needs you" a minute after they finished. The one thing it
          // does prove is that the agent is not working — useful if Stop went missing.
          return current === 'working' ? null : 'keep'
        case 'info':
          return 'keep'
        case 'resumed':
          return 'working'
        default:
          // permission prompts, elicitations and anything unrecognised (incl. pi's agent_end)
          return 'attention'
      }

    case 'hook-needs-input':
      return 'attention'

    case 'hook-input-resolved':
      // You answered, so the agent is running again. Only lifts an 'attention' —
      // it must not resurrect "working" after the turn ended.
      return current === 'attention' ? 'working' : 'keep'

    case 'bell':
      return 'attention'

    case 'visit':
      return current === 'attention' ? null : 'keep'

    case 'exit':
      return 'exited'
  }
}

import type { TabStatusValue } from '../context/TabStatusContext'

/**
 * The status dot for an AI tab is written from four independent sources (Claude/pi
 * hooks, raw PTY activity, the terminal bell, PTY exit). This module is the single
 * place that decides what wins, so the rules are testable instead of buried in
 * AiToolTab's effects.
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
  /** Claude's Notification hook / pi's agent_end. */
  | 'hook-notification'
  /** Terminal bell (non-hook tools only). */
  | 'bell'
  /** The tab became visible. */
  | 'visit'
  /** The PTY exited. */
  | 'exit'

export type AiNotificationKind = 'permission' | 'idle' | 'unknown'

export interface AiStatusCtx {
  /** Claude/pi: status comes from hooks, so silence carries no meaning. */
  isHookTab: boolean
  visible: boolean
  windowFocused: boolean
  notificationKind?: AiNotificationKind
}

/** 'keep' means "leave the status alone" — distinct from setting it to null. */
export type AiStatusDecision = TabStatusValue | 'keep'

/**
 * Claude's Notification hook fires both for permission prompts and for the 60s
 * "still waiting on you" nudge, and only `message` tells them apart. Adding a
 * newly observed string is one line here; order matters (first match wins), so
 * permission patterns come first.
 */
const NOTIFICATION_PATTERNS: { kind: AiNotificationKind; re: RegExp }[] = [
  { kind: 'permission', re: /needs? your permission/i },
  { kind: 'permission', re: /permission to use/i },
  { kind: 'permission', re: /\bapprov(e|al)\b/i },
  { kind: 'idle', re: /waiting for your input/i },
  { kind: 'idle', re: /\bidle\b/i }
]

/**
 * Anything we can't place is 'unknown' and gets treated as attention downstream:
 * a false "needs you" is cheap, a missed permission prompt blocks the agent
 * silently. Log the raw message (see statusDebug) to tighten this over time.
 */
export function classifyNotification(body: Record<string, unknown> | undefined): AiNotificationKind {
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
      return null

    case 'hook-notification':
      // The idle nudge is noise when you are already looking at the tab. A permission
      // prompt is not: it can land while you read something else in the same tab.
      if (ctx.notificationKind === 'idle' && ctx.visible && ctx.windowFocused) return 'keep'
      return 'attention'

    case 'bell':
      return 'attention'

    case 'visit':
      return current === 'attention' ? null : 'keep'

    case 'exit':
      return 'exited'
  }
}

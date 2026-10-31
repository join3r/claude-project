import React from 'react'
import type { ChatUsage } from '../../../shared/claude-chat'

/**
 * The composer's status strip, after Claude Code's own status line: how full the
 * context is (ring + used/max) and what the session would cost at API prices.
 * Each part shows once main has read it from the CLI. The plan's windows belong
 * to the account, not the task: the status bar shows them (PlanLimitChips).
 */

/** Used-context colour bands, in tokens (not percent: a 1M window degrades long before it fills). */
const CONTEXT_WARN = 150_000
const CONTEXT_DANGER = 200_000

export function contextTone(tokens: number): 'success' | 'warn' | 'danger' {
  return tokens > CONTEXT_DANGER ? 'danger' : tokens >= CONTEXT_WARN ? 'warn' : 'success'
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

export function formatCost(usd: number): string {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`
}

/** Time left until `iso`: "42m", "3h 12m", "2d 5h"; "now" once it has passed. */
export function formatResetIn(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** When `iso` falls, on the clock: "14:30" today, "Thu 09:10" on another day. */
export function formatResetAt(iso: string, now: number = Date.now()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** Plan-window colour bands, in percent used. */
export function limitTone(utilization: number): 'success' | 'warn' | 'danger' {
  return utilization > 90 ? 'danger' : utilization > 75 ? 'warn' : 'success'
}

const TONE_TEXT = { success: 'text-success', warn: 'text-warn', danger: 'text-danger' } as const

function Ring({ fraction, tone }: { fraction: number; tone: keyof typeof TONE_TEXT }): React.ReactElement {
  const r = 5.5
  const circumference = 2 * Math.PI * r
  const filled = Math.min(1, Math.max(0, fraction)) * circumference
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className={`shrink-0 -rotate-90 ${TONE_TEXT[tone]}`} aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`} />
    </svg>
  )
}

export default function UsageMeter({ usage }: { usage: ChatUsage }): React.ReactElement | null {
  const { contextTokens, contextMax, costUsd } = usage
  const hasContext = contextTokens !== undefined && contextMax !== undefined && contextMax > 0
  if (!hasContext && costUsd === undefined) return null

  const tone = hasContext ? contextTone(contextTokens) : 'success'
  return (
    <div className="min-w-0 flex items-center gap-2 px-1 text-xs text-text-subtle tabular-nums whitespace-nowrap overflow-hidden">
      {hasContext && (
        <span
          className="inline-flex items-center gap-1"
          title={`Context: ${contextTokens.toLocaleString()} of ${contextMax.toLocaleString()} tokens (${Math.round((contextTokens / contextMax) * 100)}%)`}
        >
          <Ring fraction={contextTokens / contextMax} tone={tone} />
          <span><span className={TONE_TEXT[tone]}>{formatTokens(contextTokens)}</span> / {formatTokens(contextMax)}</span>
        </span>
      )}
      {costUsd !== undefined && <span title={`Session cost at API prices: $${costUsd.toFixed(4)} (an estimate)`}>{formatCost(costUsd)}</span>}
    </div>
  )
}

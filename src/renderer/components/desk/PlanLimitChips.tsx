import React, { useEffect, useState } from 'react'
import { menuCls } from '../ui'
import { usePlanLimits } from '../../planLimits'
import { accountLabel, currentWindow, type PlanAccount } from '../../../shared/plan-limits'
import type { ChatLimitWindow } from '../../../shared/claude-chat'
import { formatResetAt, formatResetIn, limitTone } from '../claude-chat/UsageMeter'

/**
 * The status bar's plan limits (redesign option A): one chip per claude.ai
 * login the Claude tabs run on, on this Mac, its SSH boxes and its servers, so
 * hosts sharing a login show once. A chip is the 5-hour bar over the weekly one,
 * the login's name and the 5-hour share used, plus the countdown once it runs
 * hot; hovering shows both windows, their resets and the hosts on it.
 */

const TONE_TEXT = { success: 'text-success', warn: 'text-warn', danger: 'text-danger' } as const
const TONE_BG = { success: 'bg-success', warn: 'bg-warn', danger: 'bg-danger' } as const

/** The clock, ticking every 30s so countdowns and passed resets stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** One bar of a window, filled by the share used; an empty track when unknown. */
function Bar({ window, thick }: { window?: ChatLimitWindow; thick?: boolean }): React.ReactElement {
  const used = window ? Math.min(100, Math.max(0, window.utilization)) : 0
  const height = thick ? 'h-1' : 'h-[3px]'
  return (
    <span className={`block ${height} rounded-full bg-[color-mix(in_srgb,currentColor_18%,transparent)] overflow-hidden`}>
      {window && <span className={`block h-full rounded-full ${TONE_BG[limitTone(used)]}`} style={{ width: `${used}%` }} />}
    </span>
  )
}

/** "Resets 14:30 · in 4h 16m"; empty when the window has no reset time. */
function resetLine(window: ChatLimitWindow, now: number): string {
  if (!window.resetsAt) return ''
  const reset = formatResetIn(window.resetsAt, now)
  if (!reset) return ''
  return reset === 'now' ? 'Resetting now' : `Resets ${formatResetAt(window.resetsAt, now)} · in ${reset}`
}

function WindowRow({ label, window, now }: { label: string; window: ChatLimitWindow; now: number }): React.ReactElement {
  const tone = limitTone(window.utilization)
  const reset = resetLine(window, now)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-text">{label}</span>
        <span className={TONE_TEXT[tone]}>{Math.round(window.utilization)}% used</span>
      </div>
      <Bar window={window} thick />
      {reset && <span className="text-text-muted">{reset}</span>}
    </div>
  )
}

const CHIP = 'flex items-center gap-1.5 h-full px-2.5 border-r-[0.5px] border-hair text-xs text-text-muted whitespace-nowrap min-w-0 bg-transparent border-y-0 border-l-0 cursor-default hover:text-text hover:bg-sel transition-colors duration-(--motion-fast) tabular-nums'

export default function PlanLimitChips(): React.ReactElement | null {
  const accounts = usePlanLimits()
  const now = useNow()
  const [hover, setHover] = useState<{ email: string; rect: DOMRect } | null>(null)
  if (accounts.length === 0) return null

  const shown = hover ? accounts.find(account => account.email === hover.email) : undefined
  return (
    <>
      {accounts.map(account => (
        <Chip
          key={account.email}
          account={account}
          label={accountLabel(account.email, accounts)}
          now={now}
          onShow={(rect) => setHover({ email: account.email, rect })}
          onHide={() => setHover(current => current?.email === account.email ? null : current)}
        />
      ))}
      {hover && shown && <Details account={shown} rect={hover.rect} now={now} />}
    </>
  )
}

function Chip({ account, label, now, onShow, onHide }: {
  account: PlanAccount
  label: string
  now: number
  onShow: (rect: DOMRect) => void
  onHide: () => void
}): React.ReactElement {
  const fiveHour = currentWindow(account.fiveHour, now)
  const sevenDay = currentWindow(account.sevenDay, now)
  // The 5-hour window is the one that stops work today; without it, the weekly one.
  const lead = fiveHour ?? sevenDay
  const tone = lead ? limitTone(lead.utilization) : 'success'
  const reset = tone !== 'success' && lead?.resetsAt ? formatResetIn(lead.resetsAt, now) : ''
  const show = (e: React.SyntheticEvent<HTMLButtonElement>): void => onShow(e.currentTarget.getBoundingClientRect())
  return (
    <button
      type="button"
      className={CHIP}
      aria-label={`${account.email}: ${fiveHour ? `5-hour limit ${Math.round(fiveHour.utilization)}% used` : ''}${fiveHour && sevenDay ? ', ' : ''}${sevenDay ? `weekly limit ${Math.round(sevenDay.utilization)}% used` : ''}`}
      onMouseEnter={show}
      onFocus={show}
      onMouseLeave={onHide}
      onBlur={onHide}
      data-testid="desk-status-plan"
    >
      <span className="inline-flex flex-col justify-center gap-0.5 w-7 shrink-0">
        <Bar window={fiveHour} />
        <Bar window={sevenDay} />
      </span>
      <span className="truncate">{label}</span>
      {lead && (
        <span className={tone === 'success' ? '' : TONE_TEXT[tone]}>
          {Math.round(lead.utilization)}%{reset && reset !== 'now' ? ` · ↺ ${reset}` : ''}
        </span>
      )}
    </button>
  )
}

/** The popover above a chip: fixed, so the bar's overflow clip doesn't cut it; right-aligned to the chip. */
function Details({ account, rect, now }: { account: PlanAccount; rect: DOMRect; now: number }): React.ReactElement {
  const fiveHour = currentWindow(account.fiveHour, now)
  const sevenDay = currentWindow(account.sevenDay, now)
  return (
    <div
      role="tooltip"
      className={`fixed z-(--z-menu) pointer-events-none w-72 flex flex-col gap-2.5 px-3 py-2.5 text-xs tabular-nums ${menuCls}`}
      style={{ right: Math.max(8, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 8 }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-text truncate">{account.email}</span>
        {account.plan && <span className="text-text-muted capitalize shrink-0">{account.plan}</span>}
      </div>
      {fiveHour && <WindowRow label="5-hour limit" window={fiveHour} now={now} />}
      {sevenDay && <WindowRow label="Weekly limit" window={sevenDay} now={now} />}
      {account.hosts.length > 0 && (
        <div className="border-t-[0.5px] border-hair pt-2 text-text-muted">Used by {account.hosts.join(', ')}</div>
      )}
    </div>
  )
}

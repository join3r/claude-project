import type { ChatLimitWindow } from './claude-chat'

/**
 * Claude plan limits per account, app-wide rather than per task: every host
 * (this desktop, its SSH boxes, its DevTool servers) reports the windows of
 * the claude.ai login its Claude tabs run on, and logins shared by several
 * hosts show once.
 */

/** One claude.ai login's plan windows, as the hosts that use it last read them. */
export interface PlanAccount {
  email: string
  /** `max`, `pro`, `team`… as the CLI reports it. */
  plan?: string
  fiveHour?: ChatLimitWindow
  sevenDay?: ChatLimitWindow
  /** When a host last read the windows (ms). */
  readAt: number
  /** The hosts whose Claude tabs last ran on this login, by their status-bar label. */
  hosts: string[]
}

/**
 * Several hosts' lists as one, sorted by email: per login the latest read's
 * windows win and the hosts add up.
 */
export function mergePlanAccounts(lists: ReadonlyArray<readonly PlanAccount[]>): PlanAccount[] {
  const byEmail = new Map<string, PlanAccount>()
  for (const list of lists) {
    for (const account of list) {
      const seen = byEmail.get(account.email)
      if (!seen) {
        byEmail.set(account.email, { ...account, hosts: [...account.hosts] })
        continue
      }
      const hosts = [...seen.hosts, ...account.hosts.filter(host => !seen.hosts.includes(host))]
      byEmail.set(account.email, account.readAt > seen.readAt ? { ...account, hosts } : { ...seen, hosts })
    }
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email))
}

/** A window as it stands at `now`: once its reset has passed, none of the new one is used yet. */
export function currentWindow(window: ChatLimitWindow | undefined, now: number): ChatLimitWindow | undefined {
  if (!window?.resetsAt) return window
  const at = Date.parse(window.resetsAt)
  return Number.isNaN(at) || at > now ? window : { utilization: 0 }
}

/** What a chip calls the account: the part before `@`, or the whole email when another account shares it. */
export function accountLabel(email: string, all: readonly PlanAccount[]): string {
  const short = email.split('@')[0] || email
  const clash = all.some(other => other.email !== email && (other.email.split('@')[0] || other.email) === short)
  return clash ? email : short
}

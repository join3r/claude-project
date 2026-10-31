import type { ChatEvent, ChatState } from '../shared/claude-chat'
import { mergePlanAccounts, type PlanAccount } from '../shared/plan-limits'

export interface PlanLimitsDeps {
  /** The status-bar label of the host a chat tab runs on (an SSH box); null for this host itself. */
  hostOfTab: (tabId: string) => string | null
  /** What this host calls itself: `This Mac` on a desktop, '' on a server (its desktop names it). */
  selfLabel: string
  now?: () => number
}

type Entry = Omit<PlanAccount, 'hosts'>

/**
 * The plan windows of every claude.ai login this host's chats run on, read from
 * their `meta` events (each one carries the account with the windows), plus the
 * lists the desktop's servers send (`setForeign`). A host counts for the login
 * its tabs last reported, so a `/login` to another account moves it.
 */
export class PlanLimits {
  private readonly entries = new Map<string, Entry>()
  /** Host label → the email its tabs last ran on. */
  private readonly hostEmail = new Map<string, string>()
  private readonly foreign = new Map<string, PlanAccount[]>()
  private readonly listeners = new Set<() => void>()
  private lastKey = '[]'

  constructor(private readonly deps: PlanLimitsDeps) {}

  /** A chat event (ClaudeChatManager.watch): only a `meta` naming the account or carrying windows counts. */
  observe(tabId: string, event: ChatEvent, state: ChatState): void {
    if (event.t !== 'meta' || !(event.info?.account || event.usage?.fiveHour || event.usage?.sevenDay)) return
    const account = state.info.account
    if (!account?.email) return
    this.hostEmail.set(this.deps.hostOfTab(tabId) ?? this.deps.selfLabel, account.email)
    const seen = this.entries.get(account.email)
    const { fiveHour, sevenDay } = state.usage
    const entry: Entry = {
      email: account.email,
      ...(account.plan ? { plan: account.plan } : seen?.plan ? { plan: seen.plan } : {}),
      ...(fiveHour ? { fiveHour } : seen?.fiveHour ? { fiveHour: seen.fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : seen?.sevenDay ? { sevenDay: seen.sevenDay } : {}),
      readAt: fiveHour || sevenDay ? (this.deps.now ?? Date.now)() : seen?.readAt ?? 0
    }
    this.entries.set(account.email, entry)
    this.changed()
  }

  /** A server's own list (null: forget it), its own host ('') named `label`. */
  setForeign(serverId: string, label: string, accounts: PlanAccount[] | null): void {
    if (accounts) this.foreign.set(serverId, accounts.map(a => ({ ...a, hosts: a.hosts.map(host => host || label) })))
    else this.foreign.delete(serverId)
    this.changed()
  }

  /** This host's logins only, as a server sends them to its desktops. */
  own(): PlanAccount[] {
    return mergePlanAccounts([[...this.entries.values()].map(entry => ({
      ...entry,
      hosts: [...this.hostEmail].filter(([, email]) => email === entry.email).map(([host]) => host)
    }))])
  }

  /** Every login: this host's and its servers'. Only logins whose windows were read. */
  accounts(): PlanAccount[] {
    return mergePlanAccounts([this.own(), ...this.foreign.values()]).filter(a => a.fiveHour || a.sevenDay)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Listeners hear of a change in what the list says; a re-read with the same numbers is none. */
  private changed(): void {
    const key = JSON.stringify([this.own(), ...this.foreign.values()].map(list => list.map(({ readAt: _readAt, ...rest }) => rest)))
    if (key === this.lastKey) return
    this.lastKey = key
    for (const listener of this.listeners) listener()
  }
}

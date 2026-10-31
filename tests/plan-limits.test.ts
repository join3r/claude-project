import { describe, expect, it } from 'vitest'
import { PlanLimits } from '../src/main/plan-limits'
import { accountLabel, currentWindow, mergePlanAccounts, type PlanAccount } from '../src/shared/plan-limits'
import { emptyChatState, reduceChat, type ChatEvent, type ChatState } from '../src/shared/claude-chat'

function tracker(now = 1000, ssh: Record<string, string> = {}): PlanLimits {
  return new PlanLimits({ selfLabel: 'This Mac', hostOfTab: (tabId) => ssh[tabId] ?? null, now: () => now })
}

/** Folds `event` into `state` and hands both to the tracker, as ClaudeChatManager.watch does. */
function feed(limits: PlanLimits, tabId: string, state: ChatState, event: ChatEvent): ChatState {
  const next = reduceChat(state, event)
  limits.observe(tabId, event, next)
  return next
}

const meta = (email: string, fiveHour: number, plan = 'max'): ChatEvent => ({
  t: 'meta',
  info: { account: { email, plan } },
  usage: { fiveHour: { utilization: fiveHour, resetsAt: '2026-10-31T15:00:00Z' }, sevenDay: { utilization: 30 } }
})

describe('PlanLimits', () => {
  it('keeps one entry per login, with the hosts whose tabs run on it', () => {
    const limits = tracker(1000, { remote: 'box (ssh)' })
    feed(limits, 'a', emptyChatState(), meta('me@example.com', 40))
    feed(limits, 'b', emptyChatState(), meta('me@example.com', 42))
    feed(limits, 'remote', emptyChatState(), meta('ops@example.com', 88, 'team'))
    expect(limits.accounts()).toEqual([
      { email: 'me@example.com', plan: 'max', fiveHour: { utilization: 42, resetsAt: '2026-10-31T15:00:00Z' }, sevenDay: { utilization: 30 }, readAt: 1000, hosts: ['This Mac'] },
      { email: 'ops@example.com', plan: 'team', fiveHour: { utilization: 88, resetsAt: '2026-10-31T15:00:00Z' }, sevenDay: { utilization: 30 }, readAt: 1000, hosts: ['box (ssh)'] }
    ])
  })

  it('moves a host to the login its tabs switched to', () => {
    const limits = tracker()
    feed(limits, 'a', emptyChatState(), meta('old@example.com', 10))
    feed(limits, 'a', emptyChatState(), meta('new@example.com', 20))
    expect(limits.accounts().map(a => [a.email, a.hosts])).toEqual([['new@example.com', ['This Mac']], ['old@example.com', []]])
  })

  it('ignores sessions without a claude.ai login, and other events', () => {
    const limits = tracker()
    let heard = 0
    limits.subscribe(() => { heard += 1 })
    feed(limits, 'a', emptyChatState(), { t: 'meta', usage: { fiveHour: { utilization: 5 } } })
    feed(limits, 'a', emptyChatState(), { t: 'meta', usage: { contextTokens: 5 } })
    expect(limits.accounts()).toEqual([])
    expect(heard).toBe(0)
  })

  it('tells listeners only when the numbers change', () => {
    const limits = tracker()
    let heard = 0
    limits.subscribe(() => { heard += 1 })
    const state = feed(limits, 'a', emptyChatState(), meta('me@example.com', 40))
    feed(limits, 'a', state, meta('me@example.com', 40))
    expect(heard).toBe(1)
    feed(limits, 'a', state, meta('me@example.com', 41))
    expect(heard).toBe(2)
  })

  it("names a server's own host after the server and merges its logins with this Mac's", () => {
    const limits = tracker(1000)
    feed(limits, 'a', emptyChatState(), meta('me@example.com', 40))
    limits.setForeign('srv', 'hetzner', [
      { email: 'me@example.com', plan: 'max', fiveHour: { utilization: 55 }, readAt: 2000, hosts: [''] }
    ])
    expect(limits.accounts()).toEqual([
      { email: 'me@example.com', plan: 'max', fiveHour: { utilization: 55 }, readAt: 2000, hosts: ['This Mac', 'hetzner'] }
    ])
    // A server's own list leaves its servers' out.
    expect(limits.own().map(a => a.fiveHour?.utilization)).toEqual([40])
    limits.setForeign('srv', 'hetzner', null)
    expect(limits.accounts()[0].hosts).toEqual(['This Mac'])
  })
})

describe('plan-limits helpers', () => {
  it('lets the latest read win when merging', () => {
    const a: PlanAccount = { email: 'x@y', fiveHour: { utilization: 1 }, readAt: 5, hosts: ['A'] }
    const b: PlanAccount = { email: 'x@y', fiveHour: { utilization: 2 }, readAt: 3, hosts: ['B', 'A'] }
    expect(mergePlanAccounts([[a], [b]])).toEqual([{ ...a, hosts: ['A', 'B'] }])
  })

  it('shows a window past its reset as unused', () => {
    const window = { utilization: 80, resetsAt: '2026-10-31T15:00:00Z' }
    expect(currentWindow(window, Date.parse('2026-10-31T14:00:00Z'))).toBe(window)
    expect(currentWindow(window, Date.parse('2026-10-31T15:00:01Z'))).toEqual({ utilization: 0 })
    expect(currentWindow({ utilization: 3 }, 0)).toEqual({ utilization: 3 })
  })

  it('names a login by its local part unless another shares it', () => {
    const all = [{ email: 'me@a.dev' }, { email: 'me@b.dev' }, { email: 'ops@b.dev' }] as PlanAccount[]
    expect(accountLabel('ops@b.dev', all)).toBe('ops')
    expect(accountLabel('me@a.dev', all)).toBe('me@a.dev')
  })
})

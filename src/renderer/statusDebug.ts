import type { TabStatusValue } from './context/TabStatusContext'

/**
 * Runtime-flippable tracing for tab status. Status bugs only show up in a real
 * session, so this ships permanently rather than being added and removed:
 *
 *   localStorage.setItem('devtool.debugStatus', '1')   // in the renderer devtools
 *
 * takes effect on the next transition — no rebuild, no restart. Set to anything
 * else (or remove it) to turn it off again.
 */
const FLAG_KEY = 'devtool.debugStatus'

export function statusDebugEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === '1'
  } catch {
    // localStorage can throw in sandboxed contexts — tracing is never worth a crash.
    return false
  }
}

export function formatStatusTransition(
  tabId: string,
  from: TabStatusValue,
  to: TabStatusValue,
  reason?: string
): string {
  return `[status] ${tabId} ${from ?? 'none'} → ${to ?? 'none'}${reason ? ` (${reason})` : ''}`
}

/** No-op unless the flag is set; safe to call on every transition. */
export function logStatusTransition(
  tabId: string,
  from: TabStatusValue,
  to: TabStatusValue,
  reason?: string
): void {
  if (!statusDebugEnabled()) return
  console.log(formatStatusTransition(tabId, from, to, reason))
}

/** Extra detail (e.g. a hook's raw notification body) under the same flag. */
export function logStatusDetail(message: string): void {
  if (!statusDebugEnabled()) return
  console.log(`[status] ${message}`)
}

import type { TabStatusValue } from '../shared/types'

/** Esc as a terminal sends it: a bare ESC byte, or its CSI u form under the kitty keyboard protocol. */
export function isInterruptKey(data: string): boolean {
  return data === '\x1b' || data === '\x1b[27u'
}

const TOOL_HOOKS = new Set(['PreToolUse', 'PostToolUse'])

/**
 * Esc in a Claude terminal tab. The CLI ends an interrupted turn without its Stop
 * hook, so nothing would ever clear "working" (or the "needs you" of a permission
 * dialog Esc just declined). The key is the only trace an interrupt leaves, so it
 * stands in for the Stop.
 *
 * Esc doesn't always interrupt (it can close a menu in the prompt instead), so a
 * main-agent tool hook before the next prompt proves the turn carried on and
 * takes the tab back to working.
 */
export class KeyInterrupts {
  private readonly stopped = new Set<string>()

  /** Esc was typed into the tab: when that ended a turn, `stop` reports its Stop. */
  pressed(tabId: string, status: TabStatusValue, stop: () => void): void {
    if (status !== 'working' && status !== 'attention') return
    stop()
    // After the Stop went through `hook`, which would have cleared it.
    this.stopped.add(tabId)
  }

  /** A hook arrived: true when it shows the interrupted turn is still running. */
  hook(tabId: string, body: Record<string, unknown>): boolean {
    if (!this.stopped.has(tabId)) return false
    const event = body.hook_event_name
    if (event === 'UserPromptSubmit' || event === 'Stop' || event === 'StopFailure' || event === 'SessionStart') {
      this.stopped.delete(tabId)
      return false
    }
    // Subagent hooks carry agent_id: a background agent outliving the turn proves nothing.
    if (typeof event !== 'string' || !TOOL_HOOKS.has(event) || typeof body.agent_id === 'string') return false
    this.stopped.delete(tabId)
    return true
  }

  forget(tabId: string): void {
    this.stopped.delete(tabId)
  }
}

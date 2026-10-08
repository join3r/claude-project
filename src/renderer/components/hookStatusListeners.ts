import type { AiStatusEvent } from '../../shared/ai-status'

/**
 * Per-tab receivers for the hook events main forwards to the windows that mount a
 * tab. Claude's terminal tab gets them from its curl hooks, the chat tab from the
 * SDK's in-process hooks — main sends both on the same channels, so both tab kinds
 * register here and drive the same status machine.
 */
export interface HookStatusCallbacks {
  onWorking: () => void
  /** `backgroundTasks`: shells/agents still running past the turn (chat tabs only). */
  onStopped: (backgroundTasks: number) => void
  onNotification: (body: Record<string, unknown>) => void
  onSessionStart: (body: Record<string, unknown>) => void
  onActivity: (statusEvent: AiStatusEvent | null) => void
}

export const hookStatusCallbacks = new Map<string, HookStatusCallbacks>()

let hookListenersRegistered = false

/** The IPC listeners are registered once per window and fan out by tab id. */
export function ensureHookListeners(): void {
  if (hookListenersRegistered) return
  hookListenersRegistered = true

  window.api.onHookWorking((tabId: string) => {
    hookStatusCallbacks.get(tabId)?.onWorking()
  })
  window.api.onHookStopped((tabId: string, backgroundTasks: number) => {
    hookStatusCallbacks.get(tabId)?.onStopped(backgroundTasks)
  })
  window.api.onHookNotification((tabId: string, body: Record<string, unknown>) => {
    hookStatusCallbacks.get(tabId)?.onNotification(body)
  })
  window.api.onHookSessionStart((tabId: string, body: Record<string, unknown>) => {
    hookStatusCallbacks.get(tabId)?.onSessionStart(body)
  })
  window.api.onHookActivity((tabId: string, statusEvent: AiStatusEvent | null) => {
    hookStatusCallbacks.get(tabId)?.onActivity(statusEvent)
  })
}

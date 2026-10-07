import { useCallback } from 'react'
import { useApp } from '../context/AppContext'
import { pickAgentTarget } from '../../shared/agent-link'
import { paletteEvents } from '../palette/paletteEvents'
import { getAgentRecency } from './agentTabRecency'
import { findTaskInProject } from '../../shared/streams'

/**
 * Links waiting for an agent tab to take them. A queue rather than a plain event:
 * the target may not be mounted yet (a hidden tab it is switched to mounts a beat
 * later), and it takes the queue over as soon as it subscribes.
 */
const pending = new Map<string, string[]>()
const receivers = new Map<string, (text: string) => void>()

export function queueAgentInsert(tabId: string, text: string): void {
  const receiver = receivers.get(tabId)
  if (receiver) {
    receiver(text)
    return
  }
  pending.set(tabId, [...(pending.get(tabId) ?? []), text])
}

/**
 * Subscribe a tab to the links addressed to it; anything queued before it mounted
 * is delivered right away. Returns the unsubscribe function.
 */
export function onAgentInsert(tabId: string, handler: (text: string) => void): () => void {
  receivers.set(tabId, handler)
  const queued = pending.get(tabId)
  if (queued) {
    pending.delete(tabId)
    for (const text of queued) handler(text)
  }
  return () => {
    if (receivers.get(tabId) === handler) receivers.delete(tabId)
  }
}

export function forgetAgentInserts(tabId: string): void {
  pending.delete(tabId)
}

export function showAgentLinkNotice(message: string): void {
  paletteEvents.emit('agent-link-notice', message)
}

/**
 * Returns `(text) => boolean` that sends a link to the task's agent tab — the one
 * last typed in, else one showing in a pane — bringing it to the front of its
 * pane. The tab inserts the text and takes focus. False, with a notice, when the
 * task has no agent tab.
 */
export function useLinkToAgent(projectId: string, taskId: string): (text: string) => boolean {
  const { projects, setActiveTab } = useApp()
  return useCallback((text: string): boolean => {
    const task = findTaskInProject(projects.find(p => p.id === projectId), taskId)
    if (!task) return false
    const tab = pickAgentTarget(task, getAgentRecency(taskId))
    if (!tab) {
      showAgentLinkNotice('No agent tab in this task. Open Pi, Claude or Codex to link to it.')
      return false
    }
    setActiveTab(projectId, taskId, tab.id)
    queueAgentInsert(tab.id, text)
    return true
  }, [projects, setActiveTab, projectId, taskId])
}

if (typeof window !== 'undefined') {
  window.addEventListener('tab-removed', (e: Event) => {
    const tabId = (e as CustomEvent<{ tabId?: string }>).detail?.tabId
    if (tabId) forgetAgentInserts(tabId)
  })
}

/** How long a freshly started agent TUI gets to turn bracketed paste on. */
export const AGENT_READY_TIMEOUT_MS = 10_000

/**
 * Whether a terminal agent tab can take a pasted link now. It needs its PTY
 * attached and its TUI up: every supported agent turns bracketed paste on when its
 * input is ready, so that is the signal; after a timeout (a TUI that never does,
 * or a reattach whose capped scrollback lost the switch) the link goes anyway.
 */
export function agentTerminalReady(state: { attachedAt: number | null; restoring: boolean; bracketedPaste: boolean; now: number }): boolean {
  if (state.attachedAt === null || state.restoring) return false
  return state.bracketedPaste || state.now - state.attachedAt >= AGENT_READY_TIMEOUT_MS
}

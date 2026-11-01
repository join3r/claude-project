import { useSyncExternalStore } from 'react'
import { emptyChatState, reduceChat, type ChatEvent, type ChatState } from '../../../shared/claude-chat'
import type { SshConfig } from '../../../shared/types'

/**
 * This window's copy of each mounted chat tab's state. Main is the source of
 * truth: `attach` returns its snapshot with a sequence number, and every event
 * after it carries the next one. Events that race ahead of the snapshot are
 * buffered and replayed on top of it, and anything at or below the snapshot's
 * seq is already in it — so the fold here matches main's exactly.
 */

interface Entry {
  state: ChatState
  seq: number
  /** Events received before the snapshot landed. */
  early: { seq: number; event: ChatEvent }[] | null
  listeners: Set<() => void>
  /** Per-event side effects the tab component wants (status, inbox). */
  onEvent: ((event: ChatEvent, prev: ChatState, next: ChatState) => void) | null
}

const entries = new Map<string, Entry>()
let listening = false

function entryFor(tabId: string): Entry {
  let entry = entries.get(tabId)
  if (!entry) {
    entry = { state: emptyChatState(), seq: -1, early: null, listeners: new Set(), onEvent: null }
    entries.set(tabId, entry)
  }
  return entry
}

function notify(entry: Entry): void {
  entry.listeners.forEach((listener) => listener())
}

function apply(entry: Entry, seq: number, event: ChatEvent): void {
  if (seq <= entry.seq) return
  const prev = entry.state
  entry.state = reduceChat(prev, event)
  entry.seq = seq
  entry.onEvent?.(event, prev, entry.state)
}

function ensureListening(): void {
  if (listening) return
  listening = true
  window.api.onChatEvent((tabId, seq, event) => {
    const entry = entries.get(tabId)
    if (!entry) return
    if (entry.early) {
      entry.early.push({ seq, event })
      return
    }
    apply(entry, seq, event)
    notify(entry)
  })
}

export interface ChatAttachConfig {
  agent?: 'claude' | 'codex' | 'pi'
  cwd: string
  sessionId: string
  projectId?: string
  sshConfig?: SshConfig
  extraArgs?: string[]
}

export async function attachChat(tabId: string, config: ChatAttachConfig): Promise<void> {
  ensureListening()
  const entry = entryFor(tabId)
  entry.early = []
  try {
    const snapshot = await window.api.chatAttach(tabId, config)
    entry.state = snapshot.state
    entry.seq = snapshot.seq
  } finally {
    const early = entry.early ?? []
    entry.early = null
    for (const { seq, event } of early) apply(entry, seq, event)
    notify(entry)
  }
}

export function setChatEventHandler(tabId: string, handler: Entry['onEvent']): void {
  entryFor(tabId).onEvent = handler
}

/** The tab is gone from this window (closed, converted): drop the copy. */
export function forgetChat(tabId: string): void {
  entries.delete(tabId)
}

export function getChatState(tabId: string): ChatState {
  return entryFor(tabId).state
}

export function useChatState(tabId: string): ChatState {
  return useSyncExternalStore(
    (listener) => {
      const entry = entryFor(tabId)
      entry.listeners.add(listener)
      return () => { entry.listeners.delete(listener) }
    },
    () => entryFor(tabId).state
  )
}

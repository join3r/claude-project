import { emptyChatState, type ChatEvent, type ChatPromptResponse, type ChatSnapshot, type ChatState } from '../../src/shared/claude-chat'
import type { ChatTabConfigShape } from '../../src/shared/chat-tab-config'
import type { ChatBridgeChats } from '../../src/main/mobile/chat-bridge'

type Listener = (seq: number, event: ChatEvent, state: ChatState) => void

interface Runtime {
  state: ChatState
  seq: number
  config: ChatTabConfigShape
  listeners: Set<Listener>
}

/**
 * `ClaudeChatManager` as the mobile bridge sees it, with no process behind it: tests
 * change a chat's state with `update` and every listener hears about it.
 */
export class FakeChats implements ChatBridgeChats {
  readonly runtimes = new Map<string, Runtime>()
  readonly sent: { tabId: string; text: string }[] = []
  readonly responses: { tabId: string; promptId: string; response: ChatPromptResponse }[] = []
  readonly interrupts: string[] = []
  readonly watchers = new Set<(tabId: string, event: ChatEvent, state: ChatState) => void>()
  /** Resolves `listen` only when released (to test an open that is still loading). */
  holdListen: Promise<void> | null = null

  async listen(tabId: string, config: ChatTabConfigShape, listener: Listener): Promise<{ snapshot: ChatSnapshot; stop: () => void }> {
    let runtime = this.runtimes.get(tabId)
    if (!runtime) {
      runtime = { state: emptyChatState(), seq: 0, config, listeners: new Set() }
      this.runtimes.set(tabId, runtime)
    }
    runtime.listeners.add(listener)
    if (this.holdListen) await this.holdListen
    const r = runtime
    return { snapshot: { seq: r.seq, state: r.state }, stop: () => r.listeners.delete(listener) }
  }

  watch(watcher: (tabId: string, event: ChatEvent, state: ChatState) => void): () => void {
    this.watchers.add(watcher)
    return () => { this.watchers.delete(watcher) }
  }

  snapshot(tabId: string): ChatSnapshot | null {
    const runtime = this.runtimes.get(tabId)
    return runtime ? { seq: runtime.seq, state: runtime.state } : null
  }

  async send(tabId: string, text: string): Promise<void> {
    this.sent.push({ tabId, text })
    this.update(tabId, (s) => ({ ...s, busy: true, items: [...s.items, { kind: 'user', id: `u${this.sent.length}`, text, images: 0 }] }))
  }

  readonly modes: { tabId: string; mode: string }[] = []

  async setPermissionMode(tabId: string, mode: string): Promise<void> {
    this.modes.push({ tabId, mode })
    this.update(tabId, (s) => ({ ...s, info: { ...s.info, permissionMode: mode } }))
  }

  readonly settings: { tabId: string; model?: string; effort?: string }[] = []

  async setModel(tabId: string, model: string | undefined): Promise<void> {
    this.settings.push({ tabId, model })
    this.update(tabId, (s) => ({ ...s, info: { ...s.info, model, modelPicked: model !== undefined } }))
  }

  async setEffort(tabId: string, effort: string | undefined): Promise<void> {
    this.settings.push({ tabId, effort })
    this.update(tabId, (s) => ({ ...s, info: { ...s.info, effort } }))
  }

  async interrupt(tabId: string): Promise<void> {
    this.interrupts.push(tabId)
  }

  respond(tabId: string, promptId: string, response: ChatPromptResponse): boolean {
    const runtime = this.runtimes.get(tabId)
    if (!runtime || !runtime.state.pending.some((p) => p.id === promptId)) return false
    this.responses.push({ tabId, promptId, response })
    this.update(tabId, (s) => ({ ...s, pending: s.pending.filter((p) => p.id !== promptId) }))
    return true
  }

  /** Replace a chat's state (creating the runtime if needed) and notify listeners. */
  update(tabId: string, change: (state: ChatState) => ChatState): void {
    let runtime = this.runtimes.get(tabId)
    if (!runtime) {
      runtime = { state: emptyChatState(), seq: 0, config: { cwd: '', sessionId: '' }, listeners: new Set() }
      this.runtimes.set(tabId, runtime)
    }
    runtime.state = change(runtime.state)
    runtime.seq += 1
    const event = { t: 'meta', info: {} } as ChatEvent
    for (const listener of [...runtime.listeners]) listener(runtime.seq, event, runtime.state)
    for (const watcher of [...this.watchers]) watcher(tabId, event, runtime.state)
  }

  listenerCount(tabId: string): number {
    return this.runtimes.get(tabId)?.listeners.size ?? 0
  }
}

// src/renderer/palette/paletteEvents.ts
type EventMap = {
  'open-settings': void
  'open-project-settings': void
  /** The New Task composer, on the current project and stream (what ⌘N opens). */
  'open-new-task': void
  'toggle-sidebar': void
  'toggle-file-browser': void
  'reload-window': void
  'open-devtools': void
  'quit-app': void
  'switch-theme': 'dark' | 'light' | 'toggle'
  'palette-prefix-set': string
  /**
   * Palette-run Ctrl+L / Ctrl+Shift+L. The editor or notebook containing `target`
   * (what had focus when the palette opened) links to its task's agent and sets
   * `handled`.
   */
  'link-to-agent': LinkToAgentRequest
  /** Short message for the agent-link banner (no agent tab, save failed). */
  'agent-link-notice': string
}

export interface LinkToAgentRequest {
  kind: 'selection' | 'file'
  target: Element | null
  handled: boolean
}

type Listener<K extends keyof EventMap> = EventMap[K] extends void
  ? () => void
  : (payload: EventMap[K]) => void

class PaletteEvents {
  private listeners = new Map<keyof EventMap, Set<(payload: any) => void>>()
  on<K extends keyof EventMap>(event: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(event)
    if (!set) { set = new Set(); this.listeners.set(event, set) }
    set.add(fn as any)
    return () => { set!.delete(fn as any) }
  }
  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K] extends void ? [] : [EventMap[K]]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of set) fn(args[0])
  }
}

export const paletteEvents = new PaletteEvents()

// What had focus when the palette opened, for commands that act on "where the
// user was" (Link Selection to Agent). One palette per window.
let paletteReturnFocus: Element | null = null
export function setPaletteReturnFocus(el: Element | null): void {
  paletteReturnFocus = el
}
export function getPaletteReturnFocus(): Element | null {
  return paletteReturnFocus
}

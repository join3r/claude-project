import type { Terminal } from '@xterm/xterm'

const USER_SCROLL_INTENT_WINDOW_MS = 250
const SCROLLBAR_VISIBLE_MS = 800
const SCROLL_INTENT_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End'
])

export function isTerminalScrollIntentKey(key: string): boolean {
  return SCROLL_INTENT_KEYS.has(key)
}

export function hasRecentScrollIntent(
  lastIntentAt: number,
  now: number = Date.now(),
  intentWindowMs: number = USER_SCROLL_INTENT_WINDOW_MS
): boolean {
  return now - lastIntentAt <= intentWindowMs
}

export function bindTransientScrollbar(container: HTMLElement, term: Terminal): { dispose(): void } {
  const root = term.element
  if (!root) {
    return { dispose() {} }
  }

  const scrollableElement = root.querySelector('.xterm-scrollable-element')
  let lastScrollIntentAt = 0
  let pointerScrolling = false
  let scrollTimer: ReturnType<typeof setTimeout> | null = null

  const noteScrollIntent = () => {
    lastScrollIntentAt = Date.now()
  }

  const revealScrollbar = () => {
    container.classList.add('is-scrolling')
    if (scrollTimer) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      container.classList.remove('is-scrolling')
      scrollTimer = null
    }, SCROLLBAR_VISIBLE_MS)
  }

  const handleWheel = () => {
    noteScrollIntent()
  }

  const handleTouchStart = () => {
    noteScrollIntent()
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (isTerminalScrollIntentKey(event.key)) {
      noteScrollIntent()
    }
  }

  const handlePointerDown = () => {
    pointerScrolling = true
    noteScrollIntent()
  }

  const handlePointerUp = () => {
    pointerScrolling = false
  }

  const scrollDisposable = term.onScroll(() => {
    if (!pointerScrolling && !hasRecentScrollIntent(lastScrollIntentAt)) return
    revealScrollbar()
  })

  root.addEventListener('wheel', handleWheel, { passive: true })
  root.addEventListener('touchstart', handleTouchStart, { passive: true })
  root.addEventListener('keydown', handleKeyDown)
  scrollableElement?.addEventListener('pointerdown', handlePointerDown)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerUp)
  window.addEventListener('blur', handlePointerUp)

  return {
    dispose() {
      if (scrollTimer) {
        clearTimeout(scrollTimer)
        scrollTimer = null
      }
      container.classList.remove('is-scrolling')
      scrollDisposable.dispose()
      root.removeEventListener('wheel', handleWheel)
      root.removeEventListener('touchstart', handleTouchStart)
      root.removeEventListener('keydown', handleKeyDown)
      scrollableElement?.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      window.removeEventListener('blur', handlePointerUp)
    }
  }
}

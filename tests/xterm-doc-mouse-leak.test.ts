// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { disarmXtermDocMouseListeners } from '../src/renderer/components/xtermDisposal'

// Regression test for the "Cannot read properties of undefined (reading 'dimensions')"
// renderer crash: when an app (e.g. Claude Code) enables mouse tracking, xterm arms
// raw document-level mouseup/mousemove listeners on mousedown. If the button is
// released outside the window those listeners stay armed, and Terminal.dispose()
// does not remove them. The next mouseup in the window then calls into the disposed
// terminal's RenderService and throws. disarmXtermDocMouseListeners() must be called
// before dispose() so xterm cleanly removes those listeners itself.

describe('xterm document mouse listener leak on dispose', () => {
  const armed = new Set<EventListenerOrEventListenerObject>()
  let origAdd: typeof document.addEventListener
  let origRemove: typeof document.removeEventListener
  let container: HTMLDivElement

  beforeEach(() => {
    if (!('ResizeObserver' in globalThis)) {
      class Obs { observe(): void {} unobserve(): void {} disconnect(): void {} }
      ;(globalThis as Record<string, unknown>).ResizeObserver = Obs
    }
    if (!window.matchMedia) {
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      })) as typeof window.matchMedia
    }

    armed.clear()
    origAdd = document.addEventListener.bind(document)
    origRemove = document.removeEventListener.bind(document)
    document.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (type === 'mouseup' || type === 'mousemove') armed.add(fn)
      return origAdd(type as keyof DocumentEventMap, fn as EventListener, opts as AddEventListenerOptions)
    }) as typeof document.addEventListener
    document.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
      armed.delete(fn)
      return origRemove(type as keyof DocumentEventMap, fn as EventListener, opts as EventListenerOptions)
    }) as typeof document.removeEventListener

    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    document.addEventListener = origAdd
    document.removeEventListener = origRemove
    container.remove()
  })

  async function openMouseTrackingTerminal(): Promise<Terminal> {
    const term = new Terminal()
    term.open(container)
    // Enable button-event mouse tracking + SGR encoding, like Claude Code's TUI does
    await new Promise<void>(resolve => term.write('\x1b[?1002;1006h', resolve))
    return term
  }

  function pressMouseInTerminal(): void {
    const el = container.querySelector('.xterm')
    expect(el).not.toBeNull()
    el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }))
  }

  it('arms document listeners on mousedown that survive dispose (the upstream leak)', async () => {
    const term = await openMouseTrackingTerminal()
    expect(armed.size).toBe(0)
    pressMouseInTerminal()
    expect(armed.size).toBeGreaterThan(0)
    term.dispose()
    // Upstream xterm bug: dispose() does NOT remove the armed document listeners.
    // If this assertion ever fails, xterm fixed it and the disarm workaround can go.
    expect(armed.size).toBeGreaterThan(0)
    // Clean up the leaked listeners so they don't poison other tests
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0 }))
  })

  it('disarmXtermDocMouseListeners before dispose removes the armed listeners', async () => {
    const term = await openMouseTrackingTerminal()
    pressMouseInTerminal()
    expect(armed.size).toBeGreaterThan(0)

    disarmXtermDocMouseListeners(document)
    term.dispose()

    expect(armed.size).toBe(0)
    // A later click anywhere must not reach a disposed terminal
    expect(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0 }))
    }).not.toThrow()
  })

  it('is a no-op when nothing is armed', async () => {
    const term = await openMouseTrackingTerminal()
    expect(armed.size).toBe(0)
    expect(() => disarmXtermDocMouseListeners(document)).not.toThrow()
    disarmXtermDocMouseListeners(document)
    term.dispose()
    expect(armed.size).toBe(0)
  })
})

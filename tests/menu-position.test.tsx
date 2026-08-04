// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'

// React import is required by the JSX runtime under vitest's default transform.
void React

import { useMenuPosition, type MenuAnchor } from '../src/renderer/hooks/useMenuPosition'

const MENU_W = 180
const MENU_H = 200

let menuHeight = MENU_H

function Harness({ anchor }: { anchor: MenuAnchor | null }): React.ReactElement | null {
  const pos = useMenuPosition<HTMLDivElement>(anchor)
  if (!anchor) return null
  return <div data-testid="menu" ref={pos.ref} style={pos.style} />
}

function styleOf(el: HTMLElement): { left: number; top: number; maxHeight: string; overflowY: string } {
  return {
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
    maxHeight: el.style.maxHeight,
    overflowY: el.style.overflowY
  }
}

beforeEach(() => {
  menuHeight = MENU_H
  window.innerWidth = 1000
  window.innerHeight = 600
  ;(globalThis as any).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  // jsdom has no layout: report the menu's intrinsic box, clamped by any
  // max-height the hook applied (mirrors what a real browser measures).
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const cap = parseFloat(this.style.maxHeight)
    const height = Number.isNaN(cap) ? menuHeight : Math.min(menuHeight, cap)
    return { width: MENU_W, height, top: 0, left: 0, right: MENU_W, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return menuHeight }
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const cap = parseFloat(this.style.maxHeight)
      return Number.isNaN(cap) ? menuHeight : Math.min(menuHeight, cap)
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useMenuPosition', () => {
  it('leaves a menu with room at the click point', () => {
    const { getByTestId } = render(<Harness anchor={{ x: 50, y: 100 }} />)
    const s = styleOf(getByTestId('menu'))
    expect(s.left).toBe(50)
    expect(s.top).toBe(100)
    expect(s.maxHeight).toBe('')
  })

  it('flips up when the menu would run past the bottom edge', () => {
    // Click near the bottom: 550 + 200 would land at 750, past the 600px window.
    const { getByTestId } = render(<Harness anchor={{ x: 50, y: 550 }} />)
    const s = styleOf(getByTestId('menu'))
    expect(s.top).toBe(350) // 550 - 200, bottom of the menu at the cursor
    expect(s.top + MENU_H).toBeLessThanOrEqual(600)
  })

  it('flips left when the menu would run past the right edge', () => {
    const { getByTestId } = render(<Harness anchor={{ x: 950, y: 100 }} />)
    const s = styleOf(getByTestId('menu'))
    expect(s.left).toBe(770) // 950 - 180
    expect(s.left + MENU_W).toBeLessThanOrEqual(1000)
  })

  it('clamps to the margin when flipping still overflows', () => {
    // Anchored 20px from the top: flipping up would put it at -180.
    menuHeight = 200
    window.innerHeight = 210
    const { getByTestId } = render(<Harness anchor={{ x: 50, y: 20 }} />)
    const s = styleOf(getByTestId('menu'))
    expect(s.top).toBeGreaterThanOrEqual(8)
  })

  it('makes a menu taller than the window scrollable', () => {
    menuHeight = 900
    const { getByTestId } = render(<Harness anchor={{ x: 50, y: 300 }} />)
    const s = styleOf(getByTestId('menu'))
    expect(s.maxHeight).toBe('584px') // 600 - 2 * 8 margin
    expect(s.overflowY).toBe('auto')
    expect(s.top).toBe(8)
  })

  it('repositions when the window is resized', () => {
    const { getByTestId } = render(<Harness anchor={{ x: 50, y: 300 }} />)
    expect(styleOf(getByTestId('menu')).top).toBe(300)
    window.innerHeight = 400
    act(() => { window.dispatchEvent(new Event('resize')) })
    const s = styleOf(getByTestId('menu'))
    expect(s.top + MENU_H).toBeLessThanOrEqual(400)
  })
})

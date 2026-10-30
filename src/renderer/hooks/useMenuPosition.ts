import { useLayoutEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { desktopPlatform } from '../hostPlatform'

const MARGIN = 8
/** The macOS title bar (`hiddenInset`): traffic lights and the window drag region. */
const MAC_TITLE_BAR = 44

/** How far from the window's top a menu may start: below the title bar on macOS. */
export function menuTopInset(): number {
  return desktopPlatform() === 'darwin' ? MAC_TITLE_BAR : MARGIN
}

export interface MenuAnchor {
  x: number
  y: number
}

/**
 * Positions a `fixed` popup opened at a click point so it always stays inside
 * the window: it flips back over the anchor when it would overflow the right
 * or bottom edge. When it fits on neither side of the anchor it takes the
 * roomier side and scrolls, rather than sliding over the anchor. On macOS it
 * never climbs into the title bar, where it would cover the traffic lights.
 *
 * Usage:
 *   const menuPos = useMenuPosition<HTMLDivElement>(contextMenu)
 *   <div ref={menuPos.ref} className="fixed ..." style={menuPos.style}>
 */
export function useMenuPosition<T extends HTMLElement>(anchor: MenuAnchor | null): {
  ref: (node: T | null) => void
  style: CSSProperties
} {
  const [node, setNode] = useState<T | null>(null)
  const [style, setStyle] = useState<CSSProperties>(() => ({
    left: anchor?.x ?? 0,
    top: anchor?.y ?? 0
  }))

  const x = anchor?.x
  const y = anchor?.y

  useLayoutEffect(() => {
    if (!node || x === undefined || y === undefined) return

    const place = (): void => {
      const rect = node.getBoundingClientRect()
      // scrollHeight ignores our own max-height clamp, so the decision below
      // stays stable once we've applied it (no observer feedback loop).
      const chrome = rect.height - node.clientHeight
      const contentHeight = node.scrollHeight + chrome
      const vw = window.innerWidth
      const vh = window.innerHeight
      const topBound = menuTopInset()
      const bottomBound = vh - MARGIN
      const width = Math.min(rect.width, vw - MARGIN * 2)

      let left = x
      if (left + width > vw - MARGIN) left = x - width
      left = Math.max(MARGIN, Math.min(left, vw - MARGIN - width))

      const below = bottomBound - y
      const above = y - topBound
      let top: number
      let maxHeight: number
      if (contentHeight <= below) {
        top = y
        maxHeight = below
      } else if (contentHeight <= above) {
        top = y - contentHeight
        maxHeight = above
      } else if (below >= above) {
        top = y
        maxHeight = below
      } else {
        maxHeight = above
        top = y - Math.min(contentHeight, maxHeight)
      }
      // An anchor outside the usable area (e.g. a click in the title bar).
      if (maxHeight <= 0) {
        maxHeight = bottomBound - topBound
        top = topBound
      }
      top = Math.max(topBound, Math.min(top, bottomBound - Math.min(contentHeight, maxHeight)))

      const scrolls = contentHeight > maxHeight
      setStyle({
        left,
        top,
        maxHeight: scrolls ? maxHeight : undefined,
        overflowY: scrolls ? 'auto' : undefined
      })
    }

    place()

    const observer = new ResizeObserver(place)
    observer.observe(node)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [node, x, y])

  return { ref: setNode, style }
}

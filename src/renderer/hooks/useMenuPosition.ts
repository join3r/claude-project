import { useLayoutEffect, useState } from 'react'
import type { CSSProperties } from 'react'

const MARGIN = 8

export interface MenuAnchor {
  x: number
  y: number
}

/**
 * Positions a `fixed` popup opened at a click point so it always stays inside
 * the window: it flips back over the anchor when it would overflow the right
 * or bottom edge, clamps to the margin as a fallback, and becomes scrollable
 * when it is taller than the viewport.
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
      const maxHeight = vh - MARGIN * 2
      const height = Math.min(contentHeight, maxHeight)
      const width = Math.min(rect.width, vw - MARGIN * 2)

      let left = x
      if (left + width > vw - MARGIN) left = x - width
      left = Math.max(MARGIN, Math.min(left, vw - MARGIN - width))

      let top = y
      if (top + height > vh - MARGIN) top = y - height
      top = Math.max(MARGIN, Math.min(top, vh - MARGIN - height))

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

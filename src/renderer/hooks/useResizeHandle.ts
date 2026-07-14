import { useCallback } from 'react'

/**
 * Shared drag-to-resize handler for panels. `edge` is which edge of the panel
 * the handle sits on; clamping is the setter's responsibility.
 */
export function useResizeHandle({
  width,
  onWidthChange,
  edge
}: {
  width: number
  onWidthChange: (width: number) => void
  edge: 'left' | 'right'
}): { onMouseDown: (e: React.MouseEvent) => void } {
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width

      const onMouseMove = (ev: MouseEvent): void => {
        const delta = edge === 'left' ? startX - ev.clientX : ev.clientX - startX
        onWidthChange(startWidth + delta)
      }

      const onMouseUp = (): void => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
      }

      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [width, onWidthChange, edge]
  )

  return { onMouseDown }
}

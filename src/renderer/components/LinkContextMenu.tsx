import React from 'react'
import { normalizeBrowserUrl } from '../browserUrl'
import { useMenuPosition } from '../hooks/useMenuPosition'

export interface LinkMenuState {
  url: string
  x: number
  y: number
}

interface Props {
  menu: LinkMenuState | null
  onClose: () => void
  onOpenInApp: (url: string) => void
}

export default function LinkContextMenu({ menu, onClose, onOpenInApp }: Props): React.ReactElement | null {
  const menuPos = useMenuPosition<HTMLDivElement>(menu)

  if (!menu) return null

  const normalized = normalizeBrowserUrl(menu.url)

  const handleOpenInApp = () => {
    onOpenInApp(normalized)
    onClose()
  }

  const handleCopyLink = () => {
    void window.api.clipboardWriteText(normalized)
    onClose()
  }

  const handleOpenExternal = () => {
    void window.api.openExternal(normalized)
    onClose()
  }

  return (
    <>
      <div
        className="fixed inset-0 z-(--z-menu)"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={menuPos.ref}
        style={menuPos.style}
        className="fixed z-(--z-menu) min-w-[180px] bg-surface border-[0.5px] border-border rounded-lg p-1 shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="block w-full rounded-md px-2.5 py-1 bg-transparent border-0 text-text text-sm text-left cursor-pointer hover:bg-sel"
          onClick={handleOpenInApp}
        >
          Open in Browser Tab
        </button>
        <button
          type="button"
          className="block w-full rounded-md px-2.5 py-1 bg-transparent border-0 text-text text-sm text-left cursor-pointer hover:bg-sel"
          onClick={handleCopyLink}
        >
          Copy Link
        </button>
        <button
          type="button"
          className="block w-full rounded-md px-2.5 py-1 bg-transparent border-0 text-text text-sm text-left cursor-pointer hover:bg-sel"
          onClick={handleOpenExternal}
        >
          Open in System Browser
        </button>
      </div>
    </>
  )
}

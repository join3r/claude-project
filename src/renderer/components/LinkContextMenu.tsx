import React from 'react'
import { normalizeBrowserUrl } from '../browserUrl'

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
        className="fixed inset-0 z-30"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        style={{ left: menu.x, top: menu.y }}
        className="fixed z-40 min-w-[180px] bg-surface border border-border rounded shadow-lg text-sm py-1"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="block w-full text-left px-3 py-1 hover:bg-surface-2 bg-transparent border-0 cursor-pointer text-text"
          onClick={handleOpenInApp}
        >
          Open in Browser Tab
        </button>
        <button
          type="button"
          className="block w-full text-left px-3 py-1 hover:bg-surface-2 bg-transparent border-0 cursor-pointer text-text"
          onClick={handleCopyLink}
        >
          Copy Link
        </button>
        <button
          type="button"
          className="block w-full text-left px-3 py-1 hover:bg-surface-2 bg-transparent border-0 cursor-pointer text-text"
          onClick={handleOpenExternal}
        >
          Open in System Browser
        </button>
      </div>
    </>
  )
}

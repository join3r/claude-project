import React, { useEffect, useRef } from 'react'
import type { SearchAddon } from '@xterm/addon-search'
import type { Terminal } from '@xterm/xterm'

interface Props {
  searchAddon: SearchAddon
  terminal: Terminal
  visible: boolean
  onClose: () => void
}

export default function TerminalSearchBar({ searchAddon, terminal, visible, onClose }: Props): React.ReactElement | null {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (visible) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [visible])

  if (!visible) return null

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const query = inputRef.current?.value ?? ''
      if (!query) return
      if (e.shiftKey) {
        searchAddon.findPrevious(query)
      } else {
        searchAddon.findNext(query)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      searchAddon.clearDecorations()
      onClose()
      terminal.focus()
    }
  }

  return (
    <div className="absolute top-1 right-4 z-10">
      <input
        ref={inputRef}
        type="text"
        placeholder="Find…"
        spellCheck={false}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          searchAddon.clearDecorations()
          onClose()
        }}
        className="bg-field text-text border border-border rounded-md px-2 h-(--ctl-h-sm) text-sm outline-none w-[200px] focus:border-border-focus focus:shadow-focus placeholder:text-text-subtle"
      />
    </div>
  )
}

import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { menuCls } from '../ui'

export interface ChipOption {
  value: string
  label: string
  description?: string
}

interface Props {
  label: string
  title: string
  options: ChipOption[]
  value: string | undefined
  onChange: (value: string) => void
  disabled?: boolean
  /** Which way the list opens; up by default, since the chips sit under a composer. */
  placement?: 'up' | 'down'
}

/** A compact dropdown in the composer's footer (model, mode, effort). */
export default function ChipMenu({ label, title, options, value, onChange, disabled, placement = 'up' }: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    // Marked handled, so a dialog around the chip closes the menu, not itself.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        title={title}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 h-5 px-1.5 rounded-md border-0 bg-transparent text-xs text-text-muted cursor-pointer hover:bg-surface-3 hover:text-text disabled:opacity-50 disabled:cursor-default transition-colors duration-(--motion-fast)"
      >
        <span className="truncate max-w-52">{label}</span>
        <ChevronDown size={11} className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div className={`absolute ${placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} left-0 z-(--z-menu) w-64 max-h-80 overflow-auto ${menuCls}`}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => { onChange(option.value); setOpen(false) }}
              className={`block w-full rounded-md px-2.5 py-1 border-0 text-left cursor-pointer hover:bg-sel ${option.value === value ? 'bg-sel' : 'bg-transparent'}`}
            >
              <div className="text-sm text-text">{option.label}</div>
              {option.description && <div className="text-xs text-text-muted leading-snug">{option.description}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

import React from 'react'
import { ChevronRight } from 'lucide-react'

interface Props {
  label: React.ReactNode
  /** Shown as "(count)" in the header while collapsed */
  count?: number
  open: boolean
  onToggle: () => void
  children?: React.ReactNode
}

/** Chevron disclosure header — a quiet affordance: muted, weight 400, never bold. */
export default function Disclosure({ label, count, open, onToggle, children }: Props): React.ReactElement {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 bg-transparent border-0 p-0 py-1 text-base font-normal text-text-muted hover:text-text cursor-pointer text-left"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 transition-transform duration-(--motion-fast) ${open ? 'rotate-90' : ''}`}
        />
        <span>
          {label}
          {!open && count !== undefined && <span> ({count})</span>}
        </span>
      </button>
      {open && children}
    </div>
  )
}

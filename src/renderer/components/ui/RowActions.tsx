import React from 'react'

interface RowActionsProps {
  children: React.ReactNode
  className?: string
}

/**
 * Hover-revealed action cluster for a row. The row itself must carry the
 * Tailwind `group` class; the cluster fades in over --motion-fast on hover.
 */
export function RowActions({ children, className }: RowActionsProps): React.ReactElement {
  return (
    <span
      className={`flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-(--motion-fast) ${className ?? ''}`}
    >
      {children}
    </span>
  )
}

interface RowActionProps {
  onClick: (e: React.MouseEvent) => void
  title?: string
  danger?: boolean
  /** Keeps a toggled action (a pin) lit at rest — pair with `on:` styling on the parent */
  on?: boolean
  children: React.ReactNode
}

/** A single icon button inside RowActions. */
export function RowAction({ onClick, title, danger, on, children }: RowActionProps): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(e) }}
      className={[
        'flex items-center justify-center size-(--ctl-h-sm) rounded-md bg-transparent border-0 cursor-pointer',
        'transition-colors duration-(--motion-fast)',
        on ? 'text-accent' : 'text-text-muted',
        danger ? 'hover:text-danger hover:bg-danger/10' : 'hover:text-text hover:bg-sel'
      ].join(' ')}
    >
      {children}
    </button>
  )
}

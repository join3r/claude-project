import React from 'react'

interface GroupProps {
  children: React.ReactNode
}

/** Inset-grouped list card (System-Settings style) for rows of toggles/switches. */
export function Group({ children }: GroupProps): React.ReactElement {
  return <div className="bg-field border border-border rounded-lg overflow-hidden">{children}</div>
}

interface GroupRowProps {
  icon?: React.ReactNode
  label: React.ReactNode
  /** Muted second line under the label */
  sub?: React.ReactNode
  /** Right-aligned control (Switch, value text, chevron…) */
  trailing?: React.ReactNode
  selected?: boolean
  disabled?: boolean
  onClick?: () => void
}

/** A row inside a Group; consecutive rows separate with a hairline. */
export function GroupRow({ icon, label, sub, trailing, selected, disabled, onClick }: GroupRowProps): React.ReactElement {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      onClick={onClick}
      disabled={onClick ? disabled : undefined}
      className={[
        'w-full flex items-center gap-2.5 px-3 py-2 text-left bg-transparent border-0 border-t border-hair first:border-t-0',
        selected ? 'bg-sel' : '',
        onClick && !disabled ? 'cursor-pointer hover:bg-surface-3' : '',
        disabled ? 'opacity-50' : ''
      ].join(' ')}
    >
      {icon && <span className="shrink-0 text-text-muted flex items-center">{icon}</span>}
      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-base text-text truncate">{label}</span>
        {sub && <span className="text-xs text-text-muted">{sub}</span>}
      </span>
      {trailing && <span className="shrink-0 flex items-center gap-2">{trailing}</span>}
    </Tag>
  )
}

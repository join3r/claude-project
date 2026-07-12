import React from 'react'

interface Props {
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  title?: string
  children: React.ReactNode
}

/** Text-link action — the standard action affordance in settings surfaces. */
export default function LinkBtn({ onClick, danger, disabled, title, children }: Props): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'bg-transparent border-0 p-0 text-sm cursor-pointer hover:underline disabled:no-underline disabled:cursor-default',
        danger ? 'text-danger' : 'text-accent',
        disabled ? 'text-text-muted' : ''
      ].join(' ')}
    >
      {children}
    </button>
  )
}

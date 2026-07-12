import React from 'react'

interface Props {
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
}

/** The one raised CTA — used only where a single call-to-action owns the surface. */
export default function PrimaryButton({ onClick, disabled, children }: Props): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'inline-flex items-center justify-center h-(--ctl-h) px-4 rounded-md border-0 cursor-pointer',
        'text-base font-medium text-accent-ink shadow-btn',
        'bg-gradient-to-b from-[color-mix(in_srgb,var(--color-accent)_86%,white)] to-accent',
        'hover:brightness-105 active:brightness-95',
        'disabled:opacity-50 disabled:cursor-not-allowed'
      ].join(' ')}
    >
      {children}
    </button>
  )
}

import React from 'react'

interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

/** Pill toggle — replaces raw checkboxes everywhere. */
export default function Switch({ checked, onChange, disabled }: Props): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative w-[34px] h-5 rounded-full border-0 shrink-0 transition-colors duration-(--motion-med)',
        checked ? 'bg-accent' : 'bg-[color-mix(in_srgb,var(--color-text)_18%,var(--color-field))]',
        disabled ? 'opacity-50 cursor-default' : 'cursor-pointer'
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-0.5 size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-all duration-(--motion-med)',
          checked ? 'left-[16px]' : 'left-0.5'
        ].join(' ')}
      />
    </button>
  )
}

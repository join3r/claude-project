import React from 'react'

interface Props<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  compact?: boolean
}

/** Segmented control for mutually-exclusive presets; the active segment is raised on the field surface. */
export default function SegCtl<T extends string>({ options, value, onChange, disabled, compact }: Props<T>): React.ReactElement {
  return (
    <div
      className={[
        'inline-flex self-start rounded-md p-0.5 gap-0.5',
        'bg-[color-mix(in_srgb,var(--color-text)_7%,var(--color-field))]',
        disabled ? 'opacity-50 pointer-events-none' : ''
      ].join(' ')}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={[
            'border-0 rounded cursor-pointer transition-colors duration-(--motion-med)',
            compact ? 'px-2 h-5 text-xs' : 'px-2.5 h-6 text-sm',
            opt.value === value
              ? 'bg-field text-text shadow-[0_1px_2px_rgba(0,0,0,0.14)]'
              : 'bg-transparent text-text-muted hover:text-text'
          ].join(' ')}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

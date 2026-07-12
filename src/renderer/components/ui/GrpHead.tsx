import React from 'react'

interface Props {
  children: React.ReactNode
  /** Optional right-aligned action row (LinkBtns) */
  actions?: React.ReactNode
}

/** Uppercase section eyebrow above a card — the only uppercase element in the app. */
export default function GrpHead({ children, actions }: Props): React.ReactElement {
  return (
    <div className="flex items-center justify-between px-1 mb-1.5 mt-4 first:mt-0">
      <div className="text-2xs font-bold uppercase tracking-[0.06em] text-text-muted">{children}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

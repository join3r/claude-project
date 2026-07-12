import React from 'react'

interface Props {
  /** Sentence-case control label */
  label?: React.ReactNode
  /** Small muted sub-label under the label */
  sub?: React.ReactNode
  /** Hairline top divider — for a second control section stacked in the same FormGroup */
  divider?: boolean
  children?: React.ReactNode
}

/** A labelled control inside a FormGroup. */
export default function SetBlock({ label, sub, divider, children }: Props): React.ReactElement {
  return (
    <div className={`flex flex-col gap-1.5 ${divider ? 'pt-2.5 border-t border-border' : ''}`}>
      {label && <div className="text-base text-text">{label}</div>}
      {sub && <div className="text-xs text-text-muted">{sub}</div>}
      {children}
    </div>
  )
}

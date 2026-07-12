import React from 'react'

interface Props {
  children: React.ReactNode
  className?: string
}

/** Bordered rounded card on the field surface — the default container for every settings control. */
export default function FormGroup({ children, className }: Props): React.ReactElement {
  return (
    <div className={`bg-field border border-border rounded-lg p-3 flex flex-col gap-2.5 ${className ?? ''}`}>
      {children}
    </div>
  )
}

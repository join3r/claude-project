import React from 'react'

/** One short muted helper line under a control. Plain language, no jargon. */
export default function HelperText({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="text-sm text-text-muted leading-snug m-0">{children}</p>
}

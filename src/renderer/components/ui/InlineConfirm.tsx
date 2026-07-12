import React, { useState } from 'react'
import LinkBtn from './LinkBtn'

interface Props {
  /** Trigger label, e.g. "Remove project…" */
  trigger: React.ReactNode
  /** Question shown while armed, e.g. "Remove this project?" */
  prompt?: React.ReactNode
  confirmLabel?: string
  onConfirm: () => void
}

/** Understated destructive action with an inline confirm step — never a dialog. */
export default function InlineConfirm({ trigger, prompt, confirmLabel = 'Confirm', onConfirm }: Props): React.ReactElement {
  const [armed, setArmed] = useState(false)

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="bg-transparent border-0 p-0 self-start text-xs text-text-muted opacity-65 hover:opacity-100 hover:text-danger cursor-pointer transition-opacity duration-(--motion-fast)"
      >
        {trigger}
      </button>
    )
  }

  return (
    <span className="flex items-center gap-2.5 text-xs text-text-muted">
      {prompt && <span>{prompt}</span>}
      <LinkBtn danger onClick={() => { setArmed(false); onConfirm() }}>{confirmLabel}</LinkBtn>
      <LinkBtn onClick={() => setArmed(false)}>Cancel</LinkBtn>
    </span>
  )
}

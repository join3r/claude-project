import React from 'react'
import type { DeskAutopilot } from './deskStart'

const baseCls = 'flex items-center gap-1.5 border rounded-full px-2.5 py-[3px] text-sm cursor-pointer whitespace-nowrap'
const offCls = `${baseCls} bg-surface-3 border-border text-text-muted hover:border-border-strong hover:text-body`
const onCls = `${baseCls} bg-surface-3 border-text-muted text-text`

/**
 * The Autopilot chip of the compose box and the ⌘K bar (decision 7 of the
 * redesign), and "+ Codex review" beside it once it is on. Off by default
 * every time: the caller resets it after each fire.
 */
export default function AutopilotChips({ value, onChange }: {
  value: DeskAutopilot
  onChange: (next: DeskAutopilot) => void
}): React.ReactElement {
  return (
    <>
      <button
        type="button"
        className={value.on ? onCls : offCls}
        aria-pressed={value.on}
        title="Autopilot: Claude works in auto mode, then the task lands and goes to Done by itself. Anything that needs you stops it into Needs you."
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange(value.on ? { on: false, review: false } : { on: true, review: value.review })}
        data-testid="desk-autopilot-chip"
      >
        {value.on && <span className="w-[6px] h-[6px] rounded-full bg-text" aria-hidden />}
        Autopilot
      </button>
      {value.on && (
        <button
          type="button"
          className={value.review ? onCls : offCls}
          aria-pressed={value.review}
          title="Codex reviews the task's changes before it lands; its findings go back to Claude once"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange({ ...value, review: !value.review })}
          data-testid="desk-autopilot-review"
        >
          + Codex review
        </button>
      )}
    </>
  )
}

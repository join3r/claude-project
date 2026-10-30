import React, { useEffect, useState } from 'react'
import { useMenuPosition, type MenuAnchor } from '../../hooks/useMenuPosition'
import { deskSnoozeChoices, toLocalInputValue } from './deskSnooze'

export interface DeskSnoozeRequest extends MenuAnchor {
  projectId: string
  taskId: string
}

/** The snooze presets at a row's Snooze button (or its S key), plus Pick a date…. */
export default function DeskSnoozeMenu({ request, onSnooze, onClose }: {
  request: DeskSnoozeRequest | null
  onSnooze: (projectId: string, taskId: string, options: { until?: number; untilAttention?: boolean }) => void
  onClose: () => void
}): React.ReactElement | null {
  const pos = useMenuPosition<HTMLDivElement>(request)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState('')

  useEffect(() => {
    setPicking(false)
    if (!request) return
    setPicked(toLocalInputValue(Date.now() + 2 * 24 * 60 * 60_000))
    const dismiss = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [request, onClose])

  if (!request) return null
  const choose = (options: { until?: number; untilAttention?: boolean }): void => {
    onSnooze(request.projectId, request.taskId, options)
    onClose()
  }
  return (
    <div
      ref={pos.ref}
      role="menu"
      aria-label="Snooze until"
      className="fixed z-(--z-menu) w-[230px] bg-surface-3 border border-border-strong rounded-[10px] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.5)]"
      style={pos.style}
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="desk-snooze-menu"
    >
      {deskSnoozeChoices(Date.now()).map(choice => (
        <button
          key={choice.id}
          type="button"
          role="menuitem"
          className="flex w-full justify-between items-center px-2.5 py-2 rounded-md bg-transparent border-0 text-base text-text cursor-pointer hover:bg-sel text-left"
          onClick={() => choose({ until: choice.until, untilAttention: choice.untilAttention })}
        >
          <span>{choice.label}</span>
          <span className="text-sm text-text-muted">{choice.hint}</span>
        </button>
      ))}
      {picking ? (
        <form
          className="flex items-center gap-1.5 px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const at = new Date(picked).getTime()
            if (Number.isFinite(at) && at > Date.now()) choose({ until: at })
          }}
        >
          <input
            type="datetime-local"
            autoFocus
            aria-label="Wake at"
            className="flex-1 min-w-0 bg-field border border-border rounded-md px-1.5 py-1 text-sm text-text [color-scheme:dark]"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
          />
          <button type="submit" className="px-2 py-1 rounded-md border-0 bg-accent text-accent-ink text-sm cursor-pointer">Snooze</button>
        </form>
      ) : (
        <button
          type="button"
          role="menuitem"
          className="flex w-full px-2.5 py-2 rounded-md bg-transparent border-0 text-base text-text cursor-pointer hover:bg-sel text-left"
          onClick={() => setPicking(true)}
        >
          Pick a date…
        </button>
      )}
    </div>
  )
}

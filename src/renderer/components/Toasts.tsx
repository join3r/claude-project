import React from 'react'
import { dismissToast, useToasts } from '../toasts'

/** The window's toasts, bottom centre, above everything but modals. */
export default function Toasts(): React.ReactElement | null {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none" role="status" aria-live="polite">
      {toasts.map(toast => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismissToast(toast.id)}
          className="pointer-events-auto px-3 py-1.5 rounded-md border border-border bg-surface-2 text-sm text-text shadow-lg cursor-pointer"
        >
          {toast.message}
        </button>
      ))}
    </div>
  )
}

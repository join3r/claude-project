import { useSyncExternalStore } from 'react'

/** A short note at the bottom of the window that goes away by itself ("<server> is offline"). */
export interface Toast {
  id: number
  message: string
}

const TOAST_MS = 4000
let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

export function showToast(message: string): void {
  // The same note twice in a row reads as one.
  if (toasts.some(toast => toast.message === message)) return
  const toast = { id: nextId++, message }
  toasts = [...toasts, toast]
  emit()
  setTimeout(() => dismissToast(toast.id), TOAST_MS)
}

export function dismissToast(id: number): void {
  const next = toasts.filter(toast => toast.id !== id)
  if (next.length === toasts.length) return
  toasts = next
  emit()
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => toasts
  )
}

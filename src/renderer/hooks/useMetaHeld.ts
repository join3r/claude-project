import { useEffect } from 'react'
import { desktopPlatform } from '../hostPlatform'

/** Body class while the task-jump modifier is held (⌘ on macOS, Ctrl elsewhere): rows show their numbers. */
export const TASK_KEYS_CLASS = 'meta-held'
/** Body class while the tab-switch modifier is held (⌃ on macOS, Alt elsewhere): tabs show their numbers. */
export const TAB_KEYS_CLASS = 'tabkey-held'

const isMac = (): boolean => desktopPlatform() === 'darwin'

/** ⌘1–9 (Ctrl elsewhere) opens that sidebar task. */
export function isTaskJumpKey(e: KeyboardEvent): boolean {
  return isMac() ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && !e.metaKey && !e.altKey
}

/** ⌃1–9 (Alt elsewhere) picks that tab of the focused pane. */
export function isTabJumpKey(e: KeyboardEvent): boolean {
  return isMac() ? e.ctrlKey && !e.metaKey && !e.altKey : e.altKey && !e.ctrlKey && !e.metaKey
}

/** The 1–9 a jump key carries, as a 0-based index; null for any other key. */
export function jumpDigit(e: KeyboardEvent): number | null {
  const digit = e.code.match(/^Digit([1-9])$/)?.[1]
  return digit ? parseInt(digit, 10) - 1 : null
}

/** Keeps {@link TASK_KEYS_CLASS} and {@link TAB_KEYS_CLASS} on `<body>` in step with the modifiers held. */
export function useMetaHeld(): void {
  useEffect(() => {
    const mac = isMac()
    const sync = (e: KeyboardEvent): void => {
      const task = mac ? e.metaKey : e.ctrlKey
      const tab = mac ? e.ctrlKey : e.altKey
      document.body.classList.toggle(TASK_KEYS_CLASS, task && !tab && !e.shiftKey)
      document.body.classList.toggle(TAB_KEYS_CLASS, tab && !task && !e.shiftKey)
    }
    const clear = (): void => {
      document.body.classList.remove(TASK_KEYS_CLASS, TAB_KEYS_CLASS)
    }

    window.addEventListener('keydown', sync, true)
    window.addEventListener('keyup', sync, true)
    window.addEventListener('blur', clear)

    return () => {
      clear()
      window.removeEventListener('keydown', sync, true)
      window.removeEventListener('keyup', sync, true)
      window.removeEventListener('blur', clear)
    }
  }, [])
}

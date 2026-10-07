import { useSyncExternalStore } from 'react'
import type { Task } from '../../shared/types'
import { findTabLocation } from '../../shared/panes'

/**
 * Which pane of a task a tab action goes to: a column index, the pane this window
 * last focused in the task, or the pane holding a given tab (a tab opening a link
 * "in app" opens it beside itself).
 */
export type PaneRef = number | 'focused' | { withTab: string }

/**
 * The pane each task last had focus in, in this window. Menu actions (Cmd+W,
 * Cmd+T, Cmd+digit) and "new tab" from outside the panes (palette, file browser)
 * land there. Not persisted: a fresh window starts on the first pane.
 */
const focusedPanes = new Map<string, number>()
const listeners = new Set<() => void>()

export function getFocusedPane(taskId: string): number {
  return focusedPanes.get(taskId) ?? 0
}

export function setFocusedPane(taskId: string, pane: number): void {
  if (focusedPanes.get(taskId) === pane) return
  focusedPanes.set(taskId, pane)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useFocusedPane(taskId: string): number {
  return useSyncExternalStore(subscribe, () => getFocusedPane(taskId))
}

/** The focused pane of `task`, clamped into its row (panes close under it). */
export function focusedPaneOf(task: Task): number {
  return Math.max(0, Math.min(task.panes.length - 1, getFocusedPane(task.id)))
}

export function resolvePaneRef(task: Task, ref: PaneRef): number {
  if (typeof ref === 'number') return ref
  if (ref === 'focused') return focusedPaneOf(task)
  return findTabLocation(task, ref.withTab)?.pane ?? focusedPaneOf(task)
}

/** The pane index an element sits in (`data-pane-index` on the pane's chrome and tab bodies). */
export function paneIndexOfElement(element: Element | null | undefined): number | null {
  const value = element?.closest<HTMLElement>('[data-pane-index]')?.dataset.paneIndex
  if (value === undefined) return null
  const index = Number(value)
  return Number.isInteger(index) && index >= 0 ? index : null
}

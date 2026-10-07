/**
 * Pure layout operations over a task's pane row: one row of columns, any count,
 * each holding at least one tab, with a width share and an active tab. Every
 * function returns `task` itself when nothing changes, so updaters replayed by the
 * projects compare-and-swap stay idempotent.
 *
 * Invariants a task leaves these functions with (see `normalizeTaskLayout`):
 * no empty pane, every `activeTabId` names a tab of its pane, widths are positive
 * and add up to 1, and `mainTabId` names a tab of the task (or is absent).
 */
import { canAddTabType, resolveMainTabId, taskTabs } from './streams'
import type { Tab, Task, TaskPane } from './types'

/** The smallest share of the row a column can be resized down to. */
export const MIN_PANE_WIDTH = 0.1

/** Where a dragged tab lands: at `index` in pane `pane`'s tab list, or in a new pane beside `pane`. */
export type PaneDropTarget =
  | { kind: 'tab'; pane: number; index: number }
  | { kind: 'split'; pane: number; side: 'left' | 'right' }

export interface TabLocation {
  pane: number
  index: number
}

/** Positive shares adding up to 1. Missing or broken widths take an even share. */
export function normalizeWidths(widths: readonly number[]): number[] {
  if (widths.length === 0) return []
  const valid = widths.filter(width => Number.isFinite(width) && width > 0)
  const fill = valid.length > 0 ? valid.reduce((sum, width) => sum + width, 0) / valid.length : 1
  const filled = widths.map(width => (Number.isFinite(width) && width > 0 ? width : fill))
  const total = filled.reduce((sum, width) => sum + width, 0)
  return filled.map(width => width / total)
}

function sameWidths(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((width, i) => Math.abs(width - b[i]) < 1e-9)
}

/**
 * `task` with this pane row: empty panes close (the rest share their space in
 * proportion), active tabs stay valid, widths add up to 1 and `mainTabId` follows
 * the tabs.
 */
export function withPaneRow(task: Task, panes: readonly TaskPane[]): Task {
  const kept = panes.filter(pane => pane.tabs.length > 0)
  const widths = normalizeWidths(kept.map(pane => pane.width))
  const nextPanes = kept.map((pane, i): TaskPane => {
    const activeTabId = pane.tabs.some(tab => tab.id === pane.activeTabId)
      ? pane.activeTabId
      : pane.tabs[pane.tabs.length - 1].id
    return activeTabId === pane.activeTabId && Math.abs(widths[i] - pane.width) < 1e-9
      ? pane
      : { ...pane, activeTabId, width: widths[i] }
  })
  const next: Task = { ...task, panes: nextPanes }
  const mainTabId = resolveMainTabId(nextPanes.flatMap(pane => pane.tabs), task.mainTabId)
  if (mainTabId) next.mainTabId = mainTabId
  else delete next.mainTabId
  return next
}

/**
 * Repair a stored task's layout (hand-edited or older files): drop malformed and
 * empty panes, fix active tabs, widths and `mainTabId`. Returns `task` itself when
 * it already holds, so it is safe to run on every load.
 */
export function normalizeTaskLayout(task: Task): Task {
  const raw: unknown = task.panes
  const panes = (Array.isArray(raw) ? raw : [])
    .filter((pane): pane is TaskPane => !!pane && typeof pane === 'object' && Array.isArray((pane as TaskPane).tabs))
    .map(pane => {
      const tabs = pane.tabs.filter(tab => !!tab && typeof tab === 'object' && typeof tab.id === 'string')
      return tabs.length === pane.tabs.length ? pane : { ...pane, tabs }
    })
  const next = withPaneRow(task, panes)
  const unchanged = Array.isArray(raw)
    && next.panes.length === raw.length
    && next.panes.every((pane, i) => pane === (raw as TaskPane[])[i])
    && next.mainTabId === task.mainTabId
    && sameWidths(next.panes.map(pane => pane.width), (raw as TaskPane[]).map(pane => pane.width))
  return unchanged ? task : next
}

export function findTabLocation(task: Task, tabId: string): TabLocation | null {
  for (let pane = 0; pane < task.panes.length; pane++) {
    const index = task.panes[pane].tabs.findIndex(tab => tab.id === tabId)
    if (index >= 0) return { pane, index }
  }
  return null
}

/** Show the tab bar? One tab means one pane and no bar; two or more give every pane a bar. */
export function showsTabBars(task: Task): boolean {
  return taskTabs(task).length >= 2
}

function clampPane(task: Task, pane: number): number {
  return Math.max(0, Math.min(task.panes.length - 1, Number.isFinite(pane) ? Math.trunc(pane) : 0))
}

/**
 * The lowest index a tab other than the main one may take in pane `pane`: the
 * main (agent) tab stays first in its pane.
 */
function firstFreeIndex(task: Task, pane: number, tabId: string): number {
  if (!task.mainTabId || task.mainTabId === tabId) return 0
  return (task.panes[pane]?.tabs.findIndex(tab => tab.id === task.mainTabId) ?? -1) + 1
}

/**
 * `tab` added to pane `pane` (clamped into the row), at `index` or the end, never
 * ahead of the main tab. It becomes that pane's active tab unless `activate` is
 * false. A task with no pane gets one. A replay that finds the tab already in the
 * task is a no-op, and so is a second agent tab (`canAddTabType`).
 */
export function addTabToPane(
  task: Task,
  pane: number,
  tab: Tab,
  options: { index?: number; activate?: boolean } = {}
): Task {
  if (findTabLocation(task, tab.id) || !canAddTabType(task, tab.type)) return task
  const activate = options.activate ?? true
  if (task.panes.length === 0) {
    return withPaneRow(task, [{ tabs: [tab], activeTabId: tab.id, width: 1 }])
  }
  const target = clampPane(task, pane)
  return withPaneRow(task, task.panes.map((candidate, i) => {
    if (i !== target) return candidate
    const tabs = [...candidate.tabs]
    const index = options.index === undefined
      ? tabs.length
      : Math.max(firstFreeIndex(task, i, tab.id), Math.min(tabs.length, options.index))
    tabs.splice(index, 0, tab)
    return { ...candidate, tabs, activeTabId: activate ? tab.id : candidate.activeTabId }
  }))
}

/** The task without the tab; its pane closes when it was the last one there. */
export function removeTabFromTask(task: Task, tabId: string): Task {
  const at = findTabLocation(task, tabId)
  if (!at) return task
  return withPaneRow(task, task.panes.map((pane, i) => (
    i === at.pane ? { ...pane, tabs: pane.tabs.filter(tab => tab.id !== tabId) } : pane
  )))
}

export function setActiveTabInTask(task: Task, tabId: string): Task {
  const at = findTabLocation(task, tabId)
  if (!at || task.panes[at.pane].activeTabId === tabId) return task
  return {
    ...task,
    panes: task.panes.map((pane, i) => (i === at.pane ? { ...pane, activeTabId: tabId } : pane))
  }
}

/** Patch one tab where it is; every other tab keeps its identity. */
export function patchTabInTask(task: Task, tabId: string, patch: Partial<Tab>): Task {
  const at = findTabLocation(task, tabId)
  if (!at) return task
  const current = task.panes[at.pane].tabs[at.index]
  const changed = (Object.keys(patch) as (keyof Tab)[]).some(key => current[key] !== patch[key])
  if (!changed) return task
  return {
    ...task,
    panes: task.panes.map((pane, i) => (
      i === at.pane ? { ...pane, tabs: pane.tabs.map(tab => (tab.id === tabId ? { ...tab, ...patch } : tab)) } : pane
    ))
  }
}

/**
 * Move a tab: to `index` in a pane's tab list (`index` counts the list as it is
 * before the move, as a drop marker shows it), or into a new pane beside `pane`,
 * which takes half of that pane's width. The moved tab becomes active where it
 * lands; a pane it leaves empty closes.
 */
export function moveTabInTask(task: Task, tabId: string, target: PaneDropTarget): Task {
  const from = findTabLocation(task, tabId)
  if (!from || target.pane < 0 || target.pane >= task.panes.length) return task
  const tab = task.panes[from.pane].tabs[from.index]

  if (target.kind === 'tab') {
    const destination = task.panes[target.pane]
    // The main tab goes first wherever it lands; nothing else goes ahead of it.
    const landAt = (length: number): number => (
      tabId === task.mainTabId ? 0 : Math.max(firstFreeIndex(task, target.pane, tabId), Math.min(length, target.index))
    )
    if (target.pane === from.pane) {
      const insert = landAt(destination.tabs.length)
      const nextIndex = insert > from.index ? insert - 1 : insert
      if (nextIndex === from.index) {
        return destination.activeTabId === tabId ? task : setActiveTabInTask(task, tabId)
      }
      const tabs = destination.tabs.filter(candidate => candidate.id !== tabId)
      tabs.splice(nextIndex, 0, tab)
      return withPaneRow(task, task.panes.map((pane, i) => (i === from.pane ? { ...pane, tabs, activeTabId: tabId } : pane)))
    }
    return withPaneRow(task, task.panes.map((pane, i) => {
      if (i === from.pane) return { ...pane, tabs: pane.tabs.filter(candidate => candidate.id !== tabId) }
      if (i !== target.pane) return pane
      const tabs = [...pane.tabs]
      tabs.splice(landAt(tabs.length), 0, tab)
      return { ...pane, tabs, activeTabId: tabId }
    }))
  }

  // A pane's only tab split off beside its own pane: the row would look the same.
  if (from.pane === target.pane && task.panes[from.pane].tabs.length === 1) return task

  const panes: TaskPane[] = task.panes.map((pane, i) => (
    i === from.pane ? { ...pane, tabs: pane.tabs.filter(candidate => candidate.id !== tabId) } : pane
  ))
  const host = panes[target.pane]
  const half = host.width / 2
  const fresh: TaskPane = { tabs: [tab], activeTabId: tabId, width: half }
  panes[target.pane] = { ...host, width: half }
  panes.splice(target.side === 'left' ? target.pane : target.pane + 1, 0, fresh)
  return withPaneRow(task, panes)
}

/** "Split right": the tab moves into a new pane to the right of its own. No-op for a pane's only tab. */
export function splitTabRight(task: Task, tabId: string): Task {
  const at = findTabLocation(task, tabId)
  if (!at) return task
  return moveTabInTask(task, tabId, { kind: 'split', pane: at.pane, side: 'right' })
}

/**
 * Widths after dragging the divider right of pane `divider` to `x`, the pointer's
 * position as a share of the row (0 = left edge, 1 = right edge). Only the two
 * panes beside the divider change, and neither drops below `MIN_PANE_WIDTH`.
 */
export function dragDivider(widths: readonly number[], divider: number, x: number): number[] {
  if (divider < 0 || divider >= widths.length - 1) return [...widths]
  const start = widths.slice(0, divider).reduce((sum, width) => sum + width, 0)
  const pair = widths[divider] + widths[divider + 1]
  const min = Math.min(MIN_PANE_WIDTH, pair / 2)
  const left = Math.max(min, Math.min(pair - min, x - start))
  const next = [...widths]
  next[divider] = left
  next[divider + 1] = pair - left
  return next
}

/** The task with these column widths (normalised). A width list of the wrong length is ignored. */
export function setPaneWidths(task: Task, widths: readonly number[]): Task {
  if (widths.length !== task.panes.length) return task
  const normal = normalizeWidths(widths)
  if (sameWidths(normal, task.panes.map(pane => pane.width))) return task
  return { ...task, panes: task.panes.map((pane, i) => ({ ...pane, width: normal[i] })) }
}

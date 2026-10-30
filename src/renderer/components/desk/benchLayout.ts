import type { Tab, TabType, Task } from '../../../shared/types'
import { dragDivider } from '../../../shared/panes'

/**
 * The desk's task view (decision 9 of the redesign): the conversation is the
 * task's first Claude chat tab, full width; every other tab sits in the Bench,
 * a drawer under it. The data model is unchanged (`task.panes`): the Bench
 * shows the panes with the conversation tab left out.
 */

/**
 * What the Bench shows: the task's panes, one of the Files / Changes / Notes
 * panels, or a stream command's run log (opened from the status bar).
 */
export type BenchView = 'panes' | 'files' | 'changes' | 'notes' | 'run'

/** One entry of the Bench strip. Terminal and Browser pick (or make) a tab of that type. */
export type BenchItem = 'terminal' | 'browser' | 'files' | 'changes' | 'notes'

/** The conversation: the task's first `claude-chat` tab, in pane order. */
export function conversationTabId(task: Task): string | null {
  for (const pane of task.panes) {
    for (const tab of pane.tabs) if (tab.type === 'claude-chat') return tab.id
  }
  return null
}

export interface BenchPane {
  /** The pane holds only the conversation: its column takes no room in the Bench. */
  hidden: boolean
  tabs: Tab[]
  /** The tab the Bench shows in this pane: its active one, or the first other tab while the conversation is active. */
  activeTabId: string | null
}

/** Each pane as the Bench shows it, index for index with `task.panes`. */
export function benchPanes(task: Task, chatTabId: string | null): BenchPane[] {
  return task.panes.map(pane => {
    const tabs = chatTabId ? pane.tabs.filter(tab => tab.id !== chatTabId) : pane.tabs
    const activeTabId = tabs.some(tab => tab.id === pane.activeTabId) ? pane.activeTabId : tabs[0]?.id ?? null
    return { hidden: tabs.length === 0, tabs, activeTabId }
  })
}

/**
 * CSS grid columns for the Bench: a hidden pane and the dividers beside it
 * take no room. When the Bench shows no pane at all, the columns stay as they
 * are: the conversation spans them and needs the width.
 */
export function benchGridColumns(widths: readonly number[], panes: readonly BenchPane[]): string {
  if (widths.length === 0) return 'minmax(0, 1fr)'
  if (panes.every(pane => pane.hidden)) return widths.map(width => `minmax(0, ${width}fr)`).join(' 0px ')
  return widths.map((width, i) => {
    const column = panes[i]?.hidden ? '0px' : `minmax(0, ${width}fr)`
    if (i === 0) return column
    return `${benchDividerShown(panes, i - 1) ? '3px' : '0px'} ${column}`
  }).join(' ')
}

/** The divider after pane `divider` shows only between two panes the Bench shows. */
export function benchDividerShown(panes: readonly BenchPane[], divider: number): boolean {
  return !!panes[divider] && !!panes[divider + 1] && !panes[divider].hidden && !panes[divider + 1].hidden
}

/**
 * `dragDivider` for the Bench, where hidden panes take no width: `x` is the
 * pointer's share of the Bench's width. Hidden panes keep their widths.
 */
export function dragBenchDivider(widths: readonly number[], panes: readonly BenchPane[], divider: number, x: number): number[] {
  const shown = widths.map((width, i) => (panes[i]?.hidden ? 0 : width))
  const total = shown.reduce((sum, width) => sum + width, 0)
  if (total <= 0) return [...widths]
  const dragged = dragDivider(shown, divider, x * total)
  return dragged.map((width, i) => (panes[i]?.hidden ? widths[i] : width))
}

/** The Bench tab a strip item stands for: the shown tab of that type, else the first one. */
export function benchTabOfType(panes: readonly BenchPane[], type: TabType): string | null {
  for (const pane of panes) {
    const active = pane.tabs.find(tab => tab.id === pane.activeTabId)
    if (active?.type === type) return active.id
  }
  for (const pane of panes) {
    const tab = pane.tabs.find(candidate => candidate.type === type)
    if (tab) return tab.id
  }
  return null
}

/** Where a new Bench tab goes: the first pane the Bench shows, else the conversation's own pane. */
export function benchNewTabPane(panes: readonly BenchPane[], focusedPane: number): number {
  if (panes[focusedPane] && !panes[focusedPane].hidden) return focusedPane
  const shown = panes.findIndex(pane => !pane.hidden)
  return shown >= 0 ? shown : 0
}

/**
 * The strip item lit up: the open panel, or the type of the tab the focused
 * Bench pane shows. None for a run log, which has its own entry on the strip.
 */
export function benchCurrentItem(panes: readonly BenchPane[], view: BenchView, focusedPane: number): BenchItem | null {
  if (view === 'run') return null
  if (view !== 'panes') return view
  const pane = panes[focusedPane] && !panes[focusedPane].hidden ? panes[focusedPane] : panes.find(candidate => !candidate.hidden)
  const type = pane?.tabs.find(tab => tab.id === pane.activeTabId)?.type
  return type === 'terminal' || type === 'browser' ? type : null
}

/** Ids of every tab in the task, for noticing one that just opened. */
export function taskTabIds(task: Task): string[] {
  return task.panes.flatMap(pane => pane.tabs.map(tab => tab.id))
}

/**
 * Whether ⌘W may close `tabId`: only a tab you can see in the Bench, which is
 * open on its panes (a task with no chat shows the Bench always). Never the
 * conversation, and never a tab hidden in a closed drawer or behind Files,
 * Changes, Notes or a run log: a dev server's terminal must not go unseen.
 */
export function benchTabClosable(task: Task, bench: { open: boolean; view: BenchView; run: unknown }, tabId: string): boolean {
  const chatTabId = conversationTabId(task)
  if (tabId === chatTabId) return false
  const showsPanes = bench.view === 'panes' || (bench.view === 'run' && !bench.run)
  return (!chatTabId || bench.open) && showsPanes
}

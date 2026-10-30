import { useSyncExternalStore } from 'react'
import type { BenchView } from './benchLayout'
import type { StreamRunLogsTarget } from '../../streamRuns'

/**
 * Each task's Bench drawer in this window: open or closed, its height and what
 * it shows. Renderer state only, like the focused pane: a fresh window starts
 * with every Bench closed. Nothing opens it by itself except the user, a run
 * from the status bar and the header's "N files changed" (`openBench`).
 */
export interface BenchState {
  open: boolean
  /** Drawer height in px, clamped to the window when laid out. */
  height: number
  view: BenchView
  /** The run log the Bench holds (view `run` shows it), until its × closes it. */
  run: StreamRunLogsTarget | null
}

export const DEFAULT_BENCH_HEIGHT = 320
export const MIN_BENCH_HEIGHT = 120

const DEFAULT_STATE: BenchState = { open: false, height: DEFAULT_BENCH_HEIGHT, view: 'panes', run: null }

const states = new Map<string, BenchState>()
const listeners = new Set<() => void>()

export function getBench(taskId: string): BenchState {
  return states.get(taskId) ?? DEFAULT_STATE
}

export function setBench(taskId: string, patch: Partial<BenchState>): void {
  const current = getBench(taskId)
  const next = { ...current, ...patch, height: Math.max(MIN_BENCH_HEIGHT, Math.round(patch.height ?? current.height)) }
  if (next.open === current.open && next.height === current.height && next.view === current.view && next.run === current.run) return
  states.set(taskId, next)
  for (const listener of [...listeners]) listener()
}

/** Open the task's Bench, on `view` when given. */
export function openBench(taskId: string, view?: BenchView): void {
  setBench(taskId, view ? { open: true, view } : { open: true })
}

/** A stream command's run log in the task's Bench (a run in the status bar). */
export function openBenchRun(taskId: string, run: StreamRunLogsTarget): void {
  const current = getBench(taskId).run
  const same = current && current.projectId === run.projectId && current.streamId === run.streamId && current.commandId === run.commandId
  setBench(taskId, { open: true, view: 'run', run: same ? current : run })
}

/** The run log's ×: back to the panes when it showed. */
export function closeBenchRun(taskId: string): void {
  const current = getBench(taskId)
  setBench(taskId, { run: null, view: current.view === 'run' ? 'panes' : current.view })
}

/** ⌘` and the strip's chevron. */
export function toggleBench(taskId: string): void {
  setBench(taskId, { open: !getBench(taskId).open })
}

/** A panel's shortcut (⇧⌘E for Files): open the Bench on it, or close it when it shows. */
export function toggleBenchView(taskId: string, view: BenchView): void {
  const current = getBench(taskId)
  setBench(taskId, current.open && current.view === view ? { open: false } : { open: true, view })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useBench(taskId: string): BenchState {
  return useSyncExternalStore(subscribe, () => getBench(taskId))
}

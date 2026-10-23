import { useEffect, useSyncExternalStore } from 'react'
import type { StreamRunAction, StreamRunState } from '../shared/stream-run'
import { showToast } from './toasts'

/**
 * This window's side of streams' app runs (main's `stream-runs.ts`): a mirror
 * of every run main pushes, fetched per project the first time one of its
 * streams is shown, and the one logs view the window has open.
 */

let states: Record<string, StreamRunState> = {}
const listeners = new Set<() => void>()
const fetched = new Set<string>()
let connected = false

function notify(): void {
  listeners.forEach((listener) => listener())
}

function setState(streamId: string, state: StreamRunState | null): void {
  const next = { ...states }
  if (state) next[streamId] = state
  else delete next[streamId]
  states = next
  notify()
}

function connect(): void {
  if (connected) return
  connected = true
  window.api.onStreamRunState((_projectId, streamId, state) => setState(streamId, state))
}

function fetchProject(projectId: string): void {
  if (fetched.has(projectId)) return
  fetched.add(projectId)
  window.api.streamRunStates(projectId).then((snapshot) => {
    // A pushed update since asking is newer than the snapshot: keep it.
    const next = { ...snapshot, ...states }
    states = next
    notify()
  }).catch(() => { fetched.delete(projectId) })
}

function subscribe(listener: () => void): () => void {
  connect()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The stream's run as its host has it; undefined when it hasn't run since the host started. */
export function useStreamRun(projectId: string, streamId: string): StreamRunState | undefined {
  useEffect(() => { fetchProject(projectId) }, [projectId])
  return useSyncExternalStore(subscribe, () => states[streamId])
}

/**
 * The project's stream that shows an app badge (running, else failed), with its
 * run: what a row standing for the whole project (an Inbox group header) shows.
 */
export function useProjectStreamRun(projectId: string, streamIds: readonly string[]): { streamId: string; run: StreamRunState } | null {
  useEffect(() => { fetchProject(projectId) }, [projectId])
  const all = useSyncExternalStore(subscribe, () => states)
  let failed: { streamId: string; run: StreamRunState } | null = null
  for (const streamId of streamIds) {
    const run = all[streamId]
    if (run?.status === 'running') return { streamId, run }
    if (!failed && run?.status === 'exited' && run.exitCode !== 0) failed = { streamId, run }
  }
  return failed
}

/** Run, Stop or Restart; a failure (no command, a folder that's gone) shows as a toast. */
export async function controlStreamRun(projectId: string, streamId: string, action: StreamRunAction): Promise<void> {
  const result = await window.api.streamRunControl(projectId, streamId, action)
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
  if (!result.ok) showToast(`Couldn't ${action === 'restart' ? 'restart' : action === 'stop' ? 'stop' : 'start'} the app: ${result.error}`)
}

// ---- the logs view ------------------------------------------------------------

export interface StreamRunLogsTarget { projectId: string; streamId: string }

/** What the window shows for a run: its logs, or the stream's Run command dialog. */
export type StreamRunView = (StreamRunLogsTarget & { view: 'logs' | 'command' }) | null

let view: StreamRunView = null
const viewListeners = new Set<() => void>()

function setView(next: StreamRunView): void {
  view = next
  viewListeners.forEach((listener) => listener())
}

export function openStreamRunLogs(target: StreamRunLogsTarget | null): void {
  setView(target ? { ...target, view: 'logs' } : null)
}

export function openStreamRunCommand(target: StreamRunLogsTarget): void {
  setView({ ...target, view: 'command' })
}

export function closeStreamRunView(): void {
  setView(null)
}

export function useStreamRunView(): StreamRunView {
  return useSyncExternalStore(
    (listener) => {
      viewListeners.add(listener)
      return () => viewListeners.delete(listener)
    },
    () => view
  )
}

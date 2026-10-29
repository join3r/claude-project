import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { runsOfStream, streamRunCrashKey, streamRunCrashed, streamRunKey, type StreamRunAction, type StreamRunState } from '../shared/stream-run'
import { showToast } from './toasts'

/**
 * This window's side of streams' command runs (main's `stream-runs.ts`): a
 * mirror of every run main pushes, by {@link streamRunKey}, fetched per project
 * the first time one of its streams is shown, and the one logs view (or command
 * picker or commands dialog) the window has open.
 */

let states: Record<string, StreamRunState> = {}
/** Which project each known run belongs to, so a project's runs can be replaced as a whole. */
const projectOfRun = new Map<string, string>()
const listeners = new Set<() => void>()
const fetched = new Set<string>()
let connected = false

function notify(): void {
  listeners.forEach((listener) => listener())
}

function setState(key: string, state: StreamRunState | null): void {
  const next = { ...states }
  if (state) next[key] = state
  else delete next[key]
  states = next
  notify()
}

function connect(): void {
  if (connected) return
  connected = true
  window.api.onStreamRunState((projectId, streamId, commandId, state) => {
    const key = streamRunKey(streamId, commandId)
    projectOfRun.set(key, projectId)
    setState(key, state)
  })
}

/**
 * Ask the project's host for its runs, once. `fresh` asks again and lets the
 * answer replace what was known (a DevTool server back online may have
 * restarted, so runs it no longer has are gone).
 */
function fetchProject(projectId: string, fresh = false): void {
  if (fetched.has(projectId) && !fresh) return
  fetched.add(projectId)
  window.api.streamRunStates(projectId).then((snapshot) => {
    for (const key of Object.keys(snapshot)) projectOfRun.set(key, projectId)
    let next: Record<string, StreamRunState>
    if (fresh) {
      next = {}
      for (const [key, state] of Object.entries(states)) {
        if (projectOfRun.get(key) !== projectId) next[key] = state
      }
      Object.assign(next, snapshot)
    } else {
      // A pushed update since asking is newer than the snapshot: keep it.
      next = { ...snapshot, ...states }
    }
    states = next
    notify()
  }).catch(() => { fetched.delete(projectId) })
}

/** Ask these projects' hosts for their runs again (a DevTool server came back online). */
export function refetchStreamRuns(projectIds: readonly string[]): void {
  connect()
  for (const projectId of projectIds) fetchProject(projectId, true)
}

function subscribe(listener: () => void): () => void {
  connect()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** One command's run as its host has it; undefined when it hasn't run since the host started. */
export function useStreamRun(projectId: string, streamId: string, commandId: string): StreamRunState | undefined {
  useEffect(() => { fetchProject(projectId) }, [projectId])
  return useSyncExternalStore(subscribe, () => states[streamRunKey(streamId, commandId)])
}

/** Every run of the stream, in the order they first ran. */
export function useStreamRuns(projectId: string, streamId: string): StreamRunState[] {
  useEffect(() => { fetchProject(projectId) }, [projectId])
  const all = useSyncExternalStore(subscribe, () => states)
  return useMemo(() => runsOfStream(all, streamId), [all, streamId])
}

/**
 * Every run this window knows, by {@link streamRunKey}, after asking each of
 * these projects' hosts: what the Inbox's Apps section lists.
 */
export function useAllStreamRuns(projectIds: readonly string[]): Record<string, StreamRunState> {
  const key = projectIds.join('\u0000')
  useEffect(() => {
    connect()
    for (const projectId of key ? key.split('\u0000') : []) fetchProject(projectId)
  }, [key])
  return useSyncExternalStore(subscribe, () => states)
}

// ---- crashes dismissed from the Inbox's Apps section --------------------------

/** `runKey:startedAt` of failed runs the Apps section was told to forget; the next run shows again. */
let dismissed: ReadonlySet<string> = new Set()
const dismissedListeners = new Set<() => void>()

export function dismissStreamRunCrash(streamId: string, run: StreamRunState): void {
  dismissed = new Set([...dismissed, streamRunCrashKey(streamId, run)])
  dismissedListeners.forEach((listener) => listener())
}

export function useDismissedStreamRunCrashes(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      dismissedListeners.add(listener)
      return () => dismissedListeners.delete(listener)
    },
    () => dismissed
  )
}

/** The run a badge stands for among `runs`: one running, else one that failed. */
export function badgeRun(runs: readonly StreamRunState[]): StreamRunState | undefined {
  return runs.find(run => run.status === 'running') ?? runs.find(streamRunCrashed)
}

/**
 * The project's stream that shows an app badge (a run running, else one that
 * failed), with that run: what a row standing for the whole project (an Inbox
 * group header) shows.
 */
export function useProjectStreamRun(projectId: string, streamIds: readonly string[]): { streamId: string; run: StreamRunState } | null {
  useEffect(() => { fetchProject(projectId) }, [projectId])
  const all = useSyncExternalStore(subscribe, () => states)
  let failed: { streamId: string; run: StreamRunState } | null = null
  for (const streamId of streamIds) {
    const runs = runsOfStream(all, streamId)
    const running = runs.find(run => run.status === 'running')
    if (running) return { streamId, run: running }
    const crashed = runs.find(streamRunCrashed)
    if (!failed && crashed) failed = { streamId, run: crashed }
  }
  return failed
}

/**
 * Run, Stop or Restart one of the stream's commands; a failure (no such command,
 * a folder that's gone) shows as a toast. `taskId` runs it in that task's
 * worktree (`StreamRuns.control`).
 */
export async function controlStreamRun(
  projectId: string, streamId: string, commandId: string, action: StreamRunAction, taskId?: string
): Promise<void> {
  const result = await (taskId
    ? window.api.streamRunControl(projectId, streamId, commandId, action, taskId)
    : window.api.streamRunControl(projectId, streamId, commandId, action))
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }))
  if (!result.ok) showToast(`Couldn't ${action === 'restart' ? 'restart' : action === 'stop' ? 'stop' : 'start'} it: ${result.error}`)
}

// ---- the logs view, the command picker and the commands dialog -----------------

export interface StreamRunStreamTarget { projectId: string; streamId: string }
export interface StreamRunLogsTarget extends StreamRunStreamTarget { commandId: string }

/** Where the picker is anchored, and the task whose worktree its pick runs in. */
export interface StreamRunPickerTarget extends StreamRunStreamTarget { x: number; y: number; taskId?: string }

/** What the window shows for runs: a run's logs, the command picker, or the stream's commands dialog. */
export type StreamRunView =
  | (StreamRunLogsTarget & { view: 'logs' })
  | (StreamRunPickerTarget & { view: 'picker' })
  | (StreamRunStreamTarget & { view: 'commands' })
  | null

let view: StreamRunView = null
const viewListeners = new Set<() => void>()

function setView(next: StreamRunView): void {
  view = next
  viewListeners.forEach((listener) => listener())
}

export function openStreamRunLogs(target: StreamRunLogsTarget | null): void {
  setView(target ? { ...target, view: 'logs' } : null)
}

/** The list of the stream's commands to Run one of (in `taskId`'s worktree, when given). */
export function openStreamRunPicker(target: StreamRunPickerTarget): void {
  setView({ ...target, view: 'picker' })
}

export function openStreamRunCommands(target: StreamRunStreamTarget): void {
  setView({ ...target, view: 'commands' })
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

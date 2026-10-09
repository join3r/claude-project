import { useSyncExternalStore } from 'react'
import type { EnsureTaskWorktreeOptions, TaskWorktreeResult, TaskWorktreeState } from '../shared/types'

/**
 * This window's side of task worktrees (main's `task-worktree.ts`): a mirror of
 * every task's {@link TaskWorktreeState}, pushed by main to all windows, and the
 * request that makes a task's worktree.
 *
 * Plus a hold: a task whose worktree exists but whose tabs must not spawn yet
 * (a move still copying the agent's session into the new worktree).
 */

let states: Record<string, TaskWorktreeState> = {}
let holds: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
let connected = false

function notify(): void {
  listeners.forEach((listener) => listener())
}

function setLocalState(taskId: string, state: TaskWorktreeState | null): void {
  const next = { ...states }
  if (state) next[taskId] = state
  else delete next[taskId]
  states = next
  notify()
}

function connect(): void {
  if (connected) return
  connected = true
  let live = new Set<string>()
  window.api.onTaskWorktreeState((taskId, state) => {
    live.add(taskId)
    setLocalState(taskId, state)
  })
  window.api.taskWorktreeStates().then((snapshot) => {
    // A live update beats the snapshot for its task.
    const merged = { ...snapshot }
    for (const taskId of live) {
      if (states[taskId]) merged[taskId] = states[taskId]
      else delete merged[taskId]
    }
    live = new Set()
    states = merged
    notify()
  }).catch(() => {})
}

function subscribe(listener: () => void): () => void {
  connect()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function subscribeLocal(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function noSubscribe(): () => void {
  return () => {}
}

/**
 * The task's worktree state. `enabled` is false for a task that can't have a
 * worktree of its own, which then never talks to main about it.
 */
export function useTaskWorktreeState(taskId: string, enabled: boolean): TaskWorktreeState | undefined {
  return useSyncExternalStore(enabled ? subscribe : noSubscribe, () => (enabled ? states[taskId] : undefined))
}

/** Whether something holds the task's tabs back (see {@link holdTaskSpawn}). */
export function useTaskSpawnHeld(taskId: string): boolean {
  return useSyncExternalStore(subscribeLocal, () => holds.has(taskId))
}

/** Keeps the task's tabs from spawning until the returned release is called. */
export function holdTaskSpawn(taskId: string): () => void {
  holds = new Set([...holds, taskId])
  notify()
  let released = false
  return () => {
    if (released) return
    released = true
    const next = new Set(holds)
    next.delete(taskId)
    holds = next
    notify()
  }
}

const requests = new Map<string, Promise<TaskWorktreeResult>>()

/**
 * Asks main for the task's worktree, once per task at a time. Main records it
 * on the task, so the tabs follow from the projects broadcast; the result is
 * for callers that need the folder right away.
 */
export function ensureTaskWorktree(projectId: string, taskId: string, options: EnsureTaskWorktreeOptions = {}): Promise<TaskWorktreeResult> {
  const running = requests.get(taskId)
  if (running) return running
  const request = window.api.taskWorktreeEnsure(projectId, taskId, options)
    .catch((err: unknown): TaskWorktreeResult => {
      // Main never answered (the IPC itself failed): show it like a git failure.
      const error = err instanceof Error ? err.message : String(err)
      setLocalState(taskId, { phase: 'failed', error })
      return { status: 'failed', error }
    })
    .finally(() => requests.delete(taskId))
  requests.set(taskId, request)
  return request
}

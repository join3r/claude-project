/**
 * The prompt queue on Project Home: prompts planned ahead, each run as a new
 * Claude chat task in its stream. The edits here are the windows'; running one is
 * main's (`main/prompt-queue-runner.ts`), so a queue keeps going with no window open.
 *
 * Every edit is data (`PromptQueueOp`) rather than a closure, and applying one to
 * a project that no longer has the item is a no-op: a window's updater is replayed
 * against the synced snapshot, so it has to be idempotent.
 */
import type { Project, QueuedPrompt, Stream } from './types'
import { findMainStream } from './streams'

export type PromptQueueOp =
  | { op: 'add'; item: QueuedPrompt }
  | { op: 'edit'; id: string; text: string }
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; toIndex: number }
  | { op: 'auto-run'; on: boolean }

/** What running a queued prompt (`prompt-queue-run`) answers. */
export type PromptQueueRunResult =
  | { ok: true; taskId: string }
  | { ok: false; error: string }

export function promptQueue(project: Project): QueuedPrompt[] {
  return project.promptQueue ?? []
}

function withQueue(project: Project, queue: QueuedPrompt[]): Project {
  const next = { ...project }
  if (queue.length > 0) next.promptQueue = queue
  else delete next.promptQueue
  return next
}

export function applyPromptQueueOp(project: Project, op: PromptQueueOp): Project {
  const queue = promptQueue(project)
  switch (op.op) {
    case 'add': {
      const text = op.item.text.trim()
      if (!text || queue.some(item => item.id === op.item.id)) return project
      return withQueue(project, [...queue, { ...op.item, text }])
    }
    case 'edit': {
      const text = op.text.trim()
      if (!text) return project
      return withQueue(project, queue.map(item => (item.id === op.id ? { ...item, text } : item)))
    }
    case 'remove':
      return queue.some(item => item.id === op.id)
        ? withQueue(project, queue.filter(item => item.id !== op.id))
        : project
    case 'move': {
      const from = queue.findIndex(item => item.id === op.id)
      if (from === -1) return project
      const to = Math.max(0, Math.min(op.toIndex, queue.length - 1))
      if (from === to) return project
      const next = [...queue]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return withQueue(project, next)
    }
    case 'auto-run': {
      const next = { ...project }
      if (op.on) {
        next.promptQueueAutoRun = true
      } else {
        delete next.promptQueueAutoRun
        // Off means "stop after this one": nothing is waited on any more.
        delete next.promptQueueWatch
      }
      return next
    }
  }
}

/** The stream a queued prompt runs in: its own while it is open, else `main`. */
export function queuedPromptStream(project: Project, item: QueuedPrompt): Stream | undefined {
  return project.streams.find(stream => stream.id === item.streamId) ?? findMainStream(project) ?? project.streams[0]
}

/** Take `id` off the queue, for running it. */
export function takeQueuedPrompt(project: Project, id: string): { project: Project; item: QueuedPrompt; index: number } | null {
  const queue = promptQueue(project)
  const index = queue.findIndex(item => item.id === id)
  if (index === -1) return null
  return { project: withQueue(project, queue.filter(item => item.id !== id)), item: queue[index], index }
}

/** Put a prompt back where it was, when running it failed before its task could start. */
export function restoreQueuedPrompt(project: Project, item: QueuedPrompt, index: number): Project {
  const queue = promptQueue(project)
  if (queue.some(candidate => candidate.id === item.id)) return project
  const next = [...queue]
  next.splice(Math.min(index, next.length), 0, item)
  return withQueue(project, next)
}

export function setPromptQueueWatch(project: Project, watch: Project['promptQueueWatch'] | null): Project {
  const next = { ...project }
  if (watch) next.promptQueueWatch = watch
  else delete next.promptQueueWatch
  return next
}

/** The queue-started task auto-run is waiting on, while it still exists. */
export function promptQueueWatchedTask(project: Project): { taskId: string; tabId: string } | null {
  const watch = project.promptQueueWatch
  if (!watch) return null
  return project.streams.some(stream => stream.tasks.some(task => task.id === watch.taskId)) ? watch : null
}

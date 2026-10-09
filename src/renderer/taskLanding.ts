import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Project, Task, TaskLandingResult } from '../shared/types'
import { findStreamOfTask, taskWorktreesSupported } from '../shared/streams'

/**
 * This window's side of landing tasks into their streams (main's
 * `task-landing.ts`). Where a landing stands is on `Task.landing`, which main
 * commits and every window gets with the projects; this store keeps only what
 * is this window's own:
 *  - the landing call it is waiting on, per task (main may still be queueing
 *    it behind another task of the stream, with no `Task.landing` yet);
 *  - a short result line per task for the task's banner ("Updated from 0.5.0",
 *    or why it failed);
 *  - tasks being closed, whose worktree is about to go: the worktree gate must
 *    not make them a new one in the moment between removal and archiving;
 *  - how far each task's stream is ahead of it ("0.5.0 +3"), polled cheaply.
 */

export type LandingOp = 'close' | 'keep' | 'discard' | 'land' | 'update' | 'retry' | 'abort' | 'fix'

export interface LandingNotice {
  tone: 'info' | 'error'
  text: string
}

/** How long a result line (not an error) stays. */
const INFO_MS = 6000

let ops: Record<string, LandingOp> = {}
let notices: Record<string, LandingNotice> = {}
let ahead: Record<string, number> = {}
let closing: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()
const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>()

function notify(): void {
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/** The task has a worktree of its own to land, in a project on this machine or a DevTool server. */
export function canLandTask(project: Project, task: Task): boolean {
  return taskWorktreesSupported(project)
    && !!task.workspace && !!findStreamOfTask(project, task.id)?.workspace
}

/** Shows `notice` on the task's banner (null clears it). Info lines go by themselves. */
export function setLandingNotice(taskId: string, notice: LandingNotice | null): void {
  const timer = noticeTimers.get(taskId)
  if (timer) clearTimeout(timer)
  noticeTimers.delete(taskId)
  notices = notice ? { ...notices, [taskId]: notice } : without(notices, taskId)
  if (notice?.tone === 'info') {
    noticeTimers.set(taskId, setTimeout(() => setLandingNotice(taskId, null), INFO_MS))
  }
  notify()
}

/**
 * Runs one landing call for the task, marked as the task's pending op until
 * main answers. A call that never reached main comes back as `failed`.
 */
export async function runLandingOp(taskId: string, op: LandingOp, call: () => Promise<TaskLandingResult>): Promise<TaskLandingResult> {
  ops = { ...ops, [taskId]: op }
  if (notices[taskId]) setLandingNotice(taskId, null)
  notify()
  try {
    return await call()
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  } finally {
    ops = without(ops, taskId)
    notify()
  }
}

/** Marks the task as being closed until the returned release is called. */
export function markTaskClosing(taskId: string): () => void {
  closing = new Set([...closing, taskId])
  notify()
  let released = false
  return () => {
    if (released) return
    released = true
    const next = new Set(closing)
    next.delete(taskId)
    closing = next
    notify()
  }
}

export function isTaskClosing(taskId: string): boolean {
  return closing.has(taskId)
}

/** The landing call this window is waiting on for the task, if any. */
export function useLandingOp(taskId: string): LandingOp | undefined {
  return useSyncExternalStore(subscribe, () => ops[taskId])
}

export function getLandingOp(taskId: string): LandingOp | undefined {
  return ops[taskId]
}

export function useLandingNotice(taskId: string): LandingNotice | undefined {
  return useSyncExternalStore(subscribe, () => notices[taskId])
}

export function useTaskClosing(taskId: string): boolean {
  return useSyncExternalStore(subscribe, () => closing.has(taskId))
}

/** Commits on the task's stream that its branch doesn't have; undefined until asked. */
export function useStreamAhead(taskId: string): number | undefined {
  return useSyncExternalStore(subscribe, () => ahead[taskId])
}

const asking = new Set<string>()

/** Asks main how far the task's stream is ahead of it (one request per task at a time). */
export function refreshStreamAhead(projectId: string, taskId: string): void {
  if (asking.has(taskId)) return
  asking.add(taskId)
  window.api.taskStreamAhead(projectId, taskId)
    .then(count => {
      const current = ahead[taskId]
      if (count === null ? current === undefined : current === count) return
      ahead = count === null ? without(ahead, taskId) : { ...ahead, [taskId]: count }
      notify()
    })
    .catch(() => {})
    .finally(() => asking.delete(taskId))
}

function refreshWhere(projects: readonly Project[], include: (project: Project, task: Task, streamId: string) => boolean): void {
  for (const project of projects) {
    for (const stream of project.streams) {
      for (const task of stream.tasks) {
        if (canLandTask(project, task) && include(project, task, stream.id)) refreshStreamAhead(project.id, task.id)
      }
    }
  }
}

/**
 * Keeps the "<stream> +N" counts fresh without a timer: the selected task when
 * it is selected (or gets its worktree), every task of a stream after a
 * landing in it ends, and all of them when the window gets focus back (a
 * commit made outside DevTool). One `rev-list --count` per task each time.
 */
export function useStreamAheadPolling(projects: readonly Project[], selectedProjectId: string | null, selectedTaskId: string | null): void {
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  // Only a window with a task that has its own worktree talks to main about it.
  const anyCandidate = projects.some(project => project.streams.some(stream => stream.tasks.some(task => canLandTask(project, task))))

  const selectedProject = projects.find(project => project.id === selectedProjectId)
  const selectedTask = selectedProject?.streams.flatMap(stream => stream.tasks).find(task => task.id === selectedTaskId)
  const selectedBranch = selectedProject && selectedTask && canLandTask(selectedProject, selectedTask) ? selectedTask.workspace?.branchName : undefined
  useEffect(() => {
    if (selectedProjectId && selectedTaskId && selectedBranch) refreshStreamAhead(selectedProjectId, selectedTaskId)
  }, [selectedProjectId, selectedTaskId, selectedBranch])

  useEffect(() => {
    if (!anyCandidate) return
    const onFocus = (): void => refreshWhere(projectsRef.current, () => true)
    window.addEventListener('focus', onFocus)
    const stop = window.api.onTaskLandingState((taskId, landing) => {
      if (landing) return
      // The task may be archived already (a close): then every stream is asked.
      const streamId = projectsRef.current.map(project => findStreamOfTask(project, taskId)).find(Boolean)?.id
      refreshWhere(projectsRef.current, (_project, _task, candidate) => !streamId || candidate === streamId)
    })
    return () => {
      window.removeEventListener('focus', onFocus)
      stop()
    }
  }, [anyCandidate])
}

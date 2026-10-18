/**
 * The question before closing a task that has a worktree of its own: the
 * desktop's close dialog (Land & close / Keep branch / Discard) and a phone's
 * `task.close` with `ask` (SPEC.md §8.7) both put it, so the two never word it
 * differently.
 */
import type { Task, TaskLandingPreview } from './types'

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "Squash 3 commits and uncommitted changes in 2 files into 0.5.0." */
export function landingSummary(preview: TaskLandingPreview, streamName: string): string {
  const { commits, uncommitted } = preview
  const changes = `uncommitted changes in ${plural(uncommitted, 'file')}`
  if (commits === 0) return `Commit ${changes} into ${streamName}.`
  return `Squash ${plural(commits, 'commit')}${uncommitted > 0 ? ` and ${changes}` : ''} into ${streamName}.`
}

export interface TaskLandingCloseQuestion {
  title: string
  /** What landing would do, or why the task can't land right now. */
  message: string
  /** The task's branch, which Keep branch leaves in the repository. */
  branch: string
  /** Null when Land & close is on offer; otherwise why not. */
  landBlocked: string | null
}

/**
 * The question before closing a task that has a worktree of its own, or null
 * to land it straight away (nothing to land: the worktree and branch just go).
 * `preview` is null when main couldn't tell what landing would take.
 */
export function taskLandingCloseQuestion(
  task: Task,
  streamName: string,
  preview: TaskLandingPreview | null,
  working: boolean
): TaskLandingCloseQuestion | null {
  const base = { title: `Close task "${task.name}"?`, branch: task.workspace?.branchName ?? '' }
  const landing = task.landing
  if (landing?.state === 'conflict' || landing?.state === 'fixing') {
    const files = landing.files?.length ? ` in ${plural(landing.files.length, 'file')}` : ''
    const what = landing.intent === 'update' ? `Updating from ${streamName}` : `Landing into ${streamName}`
    return {
      ...base,
      message: `${what} stopped on conflicts${files}. Resolve them in the task to land it, or close it without landing.`,
      landBlocked: 'Resolve the conflicts first'
    }
  }
  if (working) {
    return {
      ...base,
      message: `"${task.name}" is still working. Let it finish to land its work into ${streamName}, or close it without landing: its agent stops and its tabs close.`,
      landBlocked: 'Its agent is working'
    }
  }
  if (landing?.state === 'blocked') {
    const where = landing.files?.length ? ` in ${landing.files.join(', ')}` : ''
    return { ...base, message: `${streamName} has local changes${where}, so the last landing stopped. Land & close tries again.`, landBlocked: null }
  }
  if (!preview) return { ...base, message: `Land the task's work into ${streamName}, squashed into one commit.`, landBlocked: null }
  if (preview.commits === 0 && preview.uncommitted === 0) return null
  return { ...base, message: landingSummary(preview, streamName), landBlocked: null }
}

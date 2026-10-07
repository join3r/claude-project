import type { Project, ProjectsData, Tab, Task, WorkspaceDeleteResult } from '../../shared/types'
import { AppErrorCode, INBOX_TAB_TYPES } from '../../../protocol/ts/index.ts'
import type { TaskCloseParams, TaskCloseResult } from '../../../protocol/ts/index.ts'
import { findTaskInProject, mapTaskInProject, projectTasks, taskTabs, workspaceReleasedBy } from '../../shared/streams'
import { removeTabFromTask } from '../../shared/panes'
import { isVisibleOnMobile } from './inbox'

/**
 * `task.close` and `tab.close` (SPEC.md §8.7, §8.8): what the sidebar's Delete task
 * and a tab's close button do, run by main for a phone. Main deletes the task itself
 * (as the idle sweep does), so no window has to be open. The phone can't see the
 * desktop's confirm dialogs, so the work they warn about comes back as a `blocker`
 * until the phone resends with the matching `discard*` flag.
 */

type Outcome<T> = { ok: true; result: T } | { ok: false; code: string; message: string }

export interface CloseTaskDeps {
  peek(): ProjectsData
  /** Editor tabs with unsaved changes in any window. */
  dirtyTabIds(): string[]
  /**
   * The workspace pre-flight (no `force`): it reports uncommitted or unmerged work,
   * and removes the worktree and branch itself when there is none.
   */
  checkWorkspace(project: Project, task: Task): Promise<WorkspaceDeleteResult>
  /** Remove the worktree whatever its state; the branch too unless `keepBranch`. */
  forceDeleteWorkspace(project: Project, task: Task, keepBranch: boolean): Promise<WorkspaceDeleteResult>
  /** Tear down the task's tabs and drop it from the projects. */
  removeTask(project: Project, task: Task): Promise<void>
}

function findTask(data: ProjectsData, taskId: string): { project: Project; task: Task } | null {
  for (const project of data.projects) {
    if (!isVisibleOnMobile(project)) continue
    const task = findTaskInProject(project, taskId)
    if (task) return { project, task }
  }
  return null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function closeTask(deps: CloseTaskDeps, params: TaskCloseParams): Promise<Outcome<TaskCloseResult>> {
  const found = findTask(deps.peek(), params.taskId)
  if (!found) return { ok: false, code: AppErrorCode.NotFound, message: 'No such task' }
  const { project, task } = found
  // Only the stream's last task takes the worktree with it; a task sharing the
  // stream with others just goes.
  const workspace = workspaceReleasedBy(project, task.id)

  if (!params.discardUnsaved) {
    const dirty = new Set(deps.dirtyTabIds())
    if (taskTabs(task).some((tab) => dirty.has(tab.id))) {
      return { ok: true, result: { closed: false, blocker: 'unsaved' } }
    }
  }

  if (!workspace) {
    await deps.removeTask(project, task)
    return { ok: true, result: { closed: true } }
  }

  if (!params.discardWorkspace) {
    let check: WorkspaceDeleteResult
    try {
      check = await deps.checkWorkspace(project, task)
    } catch (err) {
      // A pre-flight that never ran is not permission to delete, as on the desktop.
      check = { status: 'check-failed', reason: errorText(err) }
    }
    const blocked = { branch: workspace.branchName, baseBranch: check.baseBranch ?? workspace.baseBranch }
    switch (check.status) {
      case 'ok':
        // Clean and merged: the pre-flight already removed the worktree and branch.
        await deps.removeTask(project, task)
        return { ok: true, result: { closed: true } }
      case 'invalid-worktree':
        // The record points at something that isn't this repo's worktree: drop the
        // task, leave the folder, say so.
        await deps.removeTask(project, task)
        return { ok: true, result: { closed: true, ...(check.reason ? { warning: check.reason } : {}) } }
      case 'check-failed':
        return { ok: true, result: { closed: false, blocker: 'check-failed', ...blocked, ...(check.reason ? { message: check.reason } : {}) } }
      default:
        return { ok: true, result: { closed: false, blocker: check.status, ...blocked } }
    }
  }

  // Tabs first, so no process holds the worktree when it is removed.
  await deps.removeTask(project, task)
  let removed: WorkspaceDeleteResult
  try {
    removed = await deps.forceDeleteWorkspace(project, task, !!params.keepBranch)
  } catch (err) {
    removed = { status: 'check-failed', reason: errorText(err) }
  }
  if (removed.status === 'ok') return { ok: true, result: { closed: true } }
  const warning = removed.reason || `The worktree "${workspace.worktreePath}" could not be removed and was left on disk.`
  return { ok: true, result: { closed: true, warning } }
}

const MOBILE_TAB_TYPES: ReadonlySet<string> = new Set<string>(INBOX_TAB_TYPES)

/** A tab the phone sees in its inbox (§4.4), with its task. */
export function findClosableTab(
  data: ProjectsData,
  tabId: string
): { project: Project; task: Task; tab: Tab } | null {
  for (const project of data.projects) {
    if (!isVisibleOnMobile(project)) continue
    for (const task of projectTasks(project)) {
      const tab = taskTabs(task).find((t) => t.id === tabId)
      if (!tab) continue
      return MOBILE_TAB_TYPES.has(tab.type) ? { project, task, tab } : null
    }
  }
  return null
}

/**
 * The task without the tab. Its pane's active tab moves to the last one left in
 * that pane, as a window does when the active tab closes; an emptied pane closes.
 */
export function removeTabFromData(data: ProjectsData, taskId: string, tabId: string): ProjectsData {
  return {
    ...data,
    projects: data.projects.map((project) => {
      if (!findTaskInProject(project, taskId)) return project
      return mapTaskInProject(project, taskId, (task) => removeTabFromTask(task, tabId))
    })
  }
}

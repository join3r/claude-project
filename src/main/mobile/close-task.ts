import type { Project, ProjectsData, Tab, Task } from '../../shared/types'
import { AppErrorCode, INBOX_TAB_TYPES } from '../../../protocol/ts/index.ts'
import type { TaskCloseParams, TaskCloseResult } from '../../../protocol/ts/index.ts'
import { findTaskInProject, isMainTab, mapTaskInProject, projectTasks, taskTabs } from '../../shared/streams'
import { removeTabFromTask } from '../../shared/panes'
import { isVisibleOnMobile } from './inbox'

/**
 * `task.close` and `tab.close` (SPEC.md §8.7, §8.8): what the sidebar's Close task
 * and a tab's close button do, run by main for a phone. Main archives the task
 * itself (to its stream's Done row, as the sidebar's ✕ does), so no window has to
 * be open. The phone can't see the desktop's confirm dialogs, so unsaved editors
 * come back as a `blocker` until the phone resends with
 * `discardUnsaved`. A task's stream (and its worktree) stays: worktrees go only
 * with their stream, which the phone can't close yet (step 9).
 */

type Outcome<T> = { ok: true; result: T } | { ok: false; code: string; message: string }

export interface CloseTaskDeps {
  peek(): ProjectsData
  /** Editor tabs with unsaved changes in any window. */
  dirtyTabIds(): string[]
  /** Tear down the task's tabs and archive it. */
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

export async function closeTask(deps: CloseTaskDeps, params: TaskCloseParams): Promise<Outcome<TaskCloseResult>> {
  const found = findTask(deps.peek(), params.taskId)
  if (!found) return { ok: false, code: AppErrorCode.NotFound, message: 'No such task' }
  const { project, task } = found
  if (!params.discardUnsaved) {
    const dirty = new Set(deps.dirtyTabIds())
    if (taskTabs(task).some((tab) => dirty.has(tab.id))) {
      return { ok: true, result: { closed: false, blocker: 'unsaved' } }
    }
  }
  await deps.removeTask(project, task)
  return { ok: true, result: { closed: true } }
}

const MOBILE_TAB_TYPES: ReadonlySet<string> = new Set<string>(INBOX_TAB_TYPES)

/**
 * A tab the phone sees in its inbox (§4.4), with its task. A task's main tab
 * isn't one: it closes only with its task.
 */
export function findClosableTab(
  data: ProjectsData,
  tabId: string
): { project: Project; task: Task; tab: Tab } | null {
  for (const project of data.projects) {
    if (!isVisibleOnMobile(project)) continue
    for (const task of projectTasks(project)) {
      const tab = taskTabs(task).find((t) => t.id === tabId)
      if (!tab) continue
      return MOBILE_TAB_TYPES.has(tab.type) && !isMainTab(task, tab.id) ? { project, task, tab } : null
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
      const task = findTaskInProject(project, taskId)
      if (!task || isMainTab(task, tabId)) return project
      return mapTaskInProject(project, taskId, (candidate) => removeTabFromTask(candidate, tabId))
    })
  }
}

import { isAgentTabType, type Project, type ProjectsData, type Stream, type Tab, type TabStatusValue, type Task, type TaskLanding, type TaskLandingResult } from '../../shared/types'
import { AppErrorCode, INBOX_TAB_TYPES, PROTOCOL_VERSION } from '../../../protocol/ts/index.ts'
import type { TaskCloseParams, TaskCloseResult, TaskLandParams, TaskLandResult } from '../../../protocol/ts/index.ts'
import { findStreamOfTask, findTaskInProject, isMainTab, mapTaskInProject, projectTasks, taskTabs, taskWorktreesSupported } from '../../shared/streams'
import { landingStatusLabel } from '../../shared/inbox-state'
import { removeTabFromTask } from '../../shared/panes'
import type { TaskLandingManager } from '../task-landing'
import { isVisibleOnMobile, wireLanding } from './inbox'

/**
 * `task.close` and `tab.close` (SPEC.md §8.7, §8.8): what the sidebar's Close task
 * and a tab's close button do, run by main for a phone. Main archives the task
 * itself (to its stream's Done row, as the sidebar's ✕ does), so no window has to
 * be open. The phone can't see the desktop's confirm dialogs, so what the sidebar
 * asks about comes back as a `blocker`, in the sidebar's order: a working agent
 * (until the phone resends with `stopWorking`), then unsaved editors (until
 * `discardUnsaved`). A task's stream (and its worktree) stays: worktrees go only
 * with their stream, which the phone doesn't close.
 *
 * A task with a worktree of its own lands instead (version 3, §8.7), through the
 * same `TaskLandingManager` call as the desktop's Close: main stops its tabs,
 * removes the worktree and archives it. A landing that stops (a conflict, the
 * stream's local changes) leaves the task open, and `task.land` (§8.15) offers
 * the banner's buttons.
 */

type Outcome<T> = { ok: true; result: T } | { ok: false; code: string; message: string }

/** The landing calls the phone can make (`TaskLandingManager`). */
export type PhoneLanding = Pick<TaskLandingManager, 'landTask' | 'fixWithAgent' | 'abortLanding' | 'retryLanding'>

export interface CloseTaskDeps {
  peek(): ProjectsData
  /** Editor tabs with unsaved changes in any window. */
  dirtyTabIds(): string[]
  /** A tab's live status (`TabActivityRegistry`). */
  statusOf(tabId: string): TabStatusValue
  /** Tear down the task's tabs and archive it. */
  removeTask(project: Project, task: Task): Promise<void>
  /** Lands a task with a worktree of its own; without it such a task is archived as above. */
  landing?: Pick<PhoneLanding, 'landTask'>
  /** Ends the task's processes, keeping their scrollback: `stopWorking` before a landing. */
  stopTabs?(project: Project, task: Task): Promise<void>
}

interface Found {
  project: Project
  stream: Stream | undefined
  task: Task
}

function findTask(data: ProjectsData, taskId: string): Found | null {
  for (const project of data.projects) {
    if (!isVisibleOnMobile(project)) continue
    const task = findTaskInProject(project, taskId)
    if (task) return { project, stream: findStreamOfTask(project, taskId), task }
  }
  return null
}

/** The desktop's `canLandTask`: a task with a worktree of its own in a worktree stream (not over SSH). */
function landsIntoStream({ project, stream, task }: Found): boolean {
  return taskWorktreesSupported(project) && !!task.workspace && !!stream?.workspace
}

/** The sidebar's `isTaskWorking`: an agent tab mid-turn. */
function agentWorking(task: Task, statusOf: (tabId: string) => TabStatusValue): boolean {
  return taskTabs(task).some((tab) => isAgentTabType(tab.type) && statusOf(tab.id) === 'working')
}

/** The task's landing as main has it now, else what the call answered. */
function currentLanding(data: ProjectsData, taskId: string, result: TaskLandingResult): TaskLanding | null {
  for (const project of data.projects) {
    const landing = findTaskInProject(project, taskId)?.landing
    if (landing) return landing
  }
  if (result.status === 'conflict') return { state: 'conflict', files: result.files }
  if (result.status === 'blocked') return { state: 'blocked', files: result.files, message: result.message }
  return null
}

function taskStillOpen(data: ProjectsData, taskId: string): boolean {
  return data.projects.some((project) => !!findTaskInProject(project, taskId))
}

/**
 * What a version 2 phone, which knows no `landing`, is told instead: the
 * desktop's own line, and where to go on.
 */
export function landingErrorMessage(landing: TaskLanding, streamName: string): string {
  const label = landingStatusLabel(landing, streamName) ?? `can't land into ${streamName}`
  // A sentence, but a stream's name stays as it is.
  const line = label.startsWith(streamName) ? label : label.charAt(0).toUpperCase() + label.slice(1)
  return landing.state === 'blocked'
    ? `${line}. Commit or stash them on the desktop, then close the task again.`
    : `${line}. Open the task on the desktop to resolve them.`
}

/** `version` is the session's protocol version: below 3 a stopped landing is an error. */
export async function closeTask(deps: CloseTaskDeps, params: TaskCloseParams, phone: { version: number } = { version: PROTOCOL_VERSION }): Promise<Outcome<TaskCloseResult>> {
  const found = findTask(deps.peek(), params.taskId)
  if (!found) return { ok: false, code: AppErrorCode.NotFound, message: 'No such task' }
  const { project, stream, task } = found
  const working = agentWorking(task, deps.statusOf)
  if (!params.stopWorking && working) {
    return { ok: true, result: { closed: false, blocker: 'working' } }
  }
  if (!params.discardUnsaved) {
    const dirty = new Set(deps.dirtyTabIds())
    if (taskTabs(task).some((tab) => dirty.has(tab.id))) {
      return { ok: true, result: { closed: false, blocker: 'unsaved' } }
    }
  }
  if (!deps.landing || !landsIntoStream(found)) {
    await deps.removeTask(project, task)
    return { ok: true, result: { closed: true } }
  }

  // Landing refuses a working agent, so "Stop it and close" stops it first.
  if (working) await deps.stopTabs?.(project, task)
  const result = await deps.landing.landTask(project.id, task.id)
  switch (result.status) {
    case 'landed':
    case 'nothing':
      // Main archived it once the worktree went.
      return { ok: true, result: { closed: true } }
    case 'working':
      return { ok: true, result: { closed: false, blocker: 'working' } }
    case 'conflict':
    case 'blocked': {
      const landing = currentLanding(deps.peek(), task.id, result)!
      if (phone.version < 3) return { ok: false, code: AppErrorCode.Internal, message: landingErrorMessage(landing, stream?.name ?? 'its stream') }
      return { ok: true, result: { closed: false, landing: wireLanding(landing) } }
    }
    case 'failed':
      return { ok: false, code: AppErrorCode.Internal, message: result.error }
    default:
      return { ok: false, code: AppErrorCode.Internal, message: `Unexpected landing result ${result.status}` }
  }
}

/**
 * `task.land` (SPEC.md §8.15): the landing banner's Ask agent to fix, Abort and
 * Retry, for a task with a worktree of its own. A Retry that finishes a close
 * has archived the task (`closed: true`).
 */
export async function landTask(deps: { peek(): ProjectsData; landing: PhoneLanding }, params: TaskLandParams): Promise<Outcome<TaskLandResult>> {
  const found = findTask(deps.peek(), params.taskId)
  if (!found) return { ok: false, code: AppErrorCode.NotFound, message: 'No such task' }
  if (!landsIntoStream(found)) return { ok: false, code: AppErrorCode.Unsupported, message: 'This task has no worktree of its own' }
  const { project, task } = found
  const result = await (params.action === 'fix-with-agent'
    ? deps.landing.fixWithAgent(project.id, task.id)
    : params.action === 'abort'
      ? deps.landing.abortLanding(project.id, task.id)
      : deps.landing.retryLanding(project.id, task.id))
  const data = deps.peek()
  switch (result.status) {
    case 'landed':
    case 'nothing':
      return { ok: true, result: taskStillOpen(data, task.id) ? { status: result.status } : { status: result.status, closed: true } }
    case 'updated':
    case 'aborted':
    case 'working':
      return { ok: true, result: { status: result.status } }
    case 'fixing':
    case 'conflict':
    case 'blocked': {
      const landing = currentLanding(data, task.id, result)
      return { ok: true, result: landing ? { status: result.status, landing: wireLanding(landing) } : { status: result.status } }
    }
    case 'failed':
      return { ok: false, code: AppErrorCode.Internal, message: result.error }
    default:
      return { ok: false, code: AppErrorCode.Internal, message: `Unexpected landing result ${result.status}` }
  }
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

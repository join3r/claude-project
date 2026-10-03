import { randomUUID } from 'crypto'
import { CLAUDE_CHAT_LABEL, isShellCommandProject, type ProjectsData, type Tab, type Task } from '../../shared/types'
import { taskNameFromPrompt } from '../../shared/task-name'
import { AppErrorCode } from '../../../protocol/ts/index.ts'
import { isVisibleOnMobile } from './inbox'

/**
 * `task.new` (SPEC.md §8.4): a new task at the end of a project, named after the
 * first prompt, with one Claude chat tab in its left pane. Main commits it itself,
 * like `chat.new`, so no window has to be open and none of them switches to it;
 * sending the prompt is the caller's next step.
 */

export type NewTaskResult =
  | { ok: true; data: ProjectsData; taskId: string; tabId: string }
  | { ok: false; code: string; message: string }

export function addTaskWithChat(
  data: ProjectsData,
  projectId: string,
  prompt: string,
  ids: () => string = randomUUID,
  now: number = Date.now()
): NewTaskResult {
  const project = data.projects.find((p) => p.id === projectId)
  if (!project || !isVisibleOnMobile(project)) return { ok: false, code: AppErrorCode.NotFound, message: 'No such project' }
  // A shell-command project runs one command, not agents; its tab bar has no Claude button.
  if (isShellCommandProject(project)) return { ok: false, code: AppErrorCode.Unsupported, message: 'This project runs a shell command, not Claude' }
  const tab: Tab = { id: ids(), type: 'claude-chat', title: CLAUDE_CHAT_LABEL, sessionId: ids() }
  const task: Task = {
    id: ids(),
    name: taskNameFromPrompt(prompt),
    tabs: { left: [tab], right: [] },
    activeTab: { left: tab.id, right: null },
    splitOpen: false,
    splitRatio: 0.5,
    lastInteractedAt: now
  }
  const stats = project.lifetimeStats ?? { tasksCreated: 0, notesCreated: 0 }
  const next: ProjectsData = {
    ...data,
    projects: data.projects.map((p) =>
      p !== project
        ? p
        : { ...p, tasks: [...(p.tasks ?? []), task], lifetimeStats: { ...stats, tasksCreated: stats.tasksCreated + 1 } }
    )
  }
  return { ok: true, data: next, taskId: task.id, tabId: tab.id }
}

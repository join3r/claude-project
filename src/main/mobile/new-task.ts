import { randomUUID } from 'crypto'
import { CLAUDE_CHAT_LABEL, isShellCommandProject, type Project, type ProjectsData, type Tab, type Task, type WorkspaceConfig } from '../../shared/types'
import { defaultBaseBranch, workspaceBranchName } from '../../shared/branch-name'
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

/** The project a phone may start a task in, or why it may not. */
export function newTaskProject(
  data: ProjectsData,
  projectId: string
): { ok: true; project: Project } | { ok: false; code: string; message: string } {
  const project = data.projects.find((p) => p.id === projectId)
  if (!project || !isVisibleOnMobile(project)) return { ok: false, code: AppErrorCode.NotFound, message: 'No such project' }
  // A shell-command project runs one command, not agents; its tab bar has no Claude button.
  if (isShellCommandProject(project)) return { ok: false, code: AppErrorCode.Unsupported, message: 'This project runs a shell command, not Claude' }
  return { ok: true, project }
}

export function addTaskWithChat(
  data: ProjectsData,
  projectId: string,
  prompt: string,
  ids: () => string = randomUUID,
  now: number = Date.now(),
  workspace?: WorkspaceConfig
): NewTaskResult {
  const found = newTaskProject(data, projectId)
  if (!found.ok) return found
  const { project } = found
  const tab: Tab = { id: ids(), type: 'claude-chat', title: CLAUDE_CHAT_LABEL, sessionId: ids() }
  const task: Task = {
    id: ids(),
    name: taskNameFromPrompt(prompt),
    tabs: { left: [tab], right: [] },
    activeTab: { left: tab.id, right: null },
    splitOpen: false,
    splitRatio: 0.5,
    lastInteractedAt: now,
    ...(workspace ? { workspace } : {})
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

/** Git for {@link makeTaskWorkspace}: the IPC's helpers in production. */
export interface WorkspaceGit {
  listBranches(project: Project): Promise<string[]>
  create(project: Project, name: string, baseBranch: string): Promise<WorkspaceConfig>
}

const WORKSPACE_ATTEMPTS = 3

/**
 * `task.new` with `workspace` (SPEC.md §8.6): what + Workspace does on the desktop's
 * first prompt — a worktree on a new branch named after the prompt, forked from
 * main, else master, else the first branch. A branch made since the listing steps
 * to the next free name, as in the prompt box.
 */
export async function makeTaskWorkspace(
  project: Project,
  prompt: string,
  git: WorkspaceGit
): Promise<{ ok: true; workspace: WorkspaceConfig } | { ok: false; code: string; message: string }> {
  let branches: string[]
  try {
    branches = await git.listBranches(project)
  } catch (err) {
    return { ok: false, code: AppErrorCode.Unsupported, message: `Could not list branches. Is this a git repository? ${errorText(err)}` }
  }
  const baseBranch = defaultBaseBranch(branches)
  if (!baseBranch) return { ok: false, code: AppErrorCode.Unsupported, message: 'This repository has no branch to start a workspace from' }
  const taken = [...branches]
  for (let attempt = 1; ; attempt++) {
    const name = workspaceBranchName(prompt, taken)
    try {
      return { ok: true, workspace: await git.create(project, name, baseBranch) }
    } catch (err) {
      const message = errorText(err)
      if (attempt < WORKSPACE_ATTEMPTS && /already exists/i.test(message)) {
        taken.push(name)
        continue
      }
      return { ok: false, code: AppErrorCode.Internal, message }
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

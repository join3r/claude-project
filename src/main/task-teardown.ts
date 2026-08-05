import type { Project, Task } from '../shared/types'

/** The per-tab teardown a window would normally do, as main has to do it. */
export interface TaskTeardownTargets {
  /** Stop the process and drop main's runtime for the tab. */
  killPty(tabId: string): void
  deleteScrollback(tabId: string): void
  forgetActivity(tabId: string): void
  /** Release this tab's Claude hook injection in `dir` (local or remote). */
  releaseHooks(project: Project, dir: string, tabId: string): Promise<void> | void
}

/** Where a task's tools run: the worktree for a workspace task, else the project dir. */
export function taskDir(project: Project, task: Task): string {
  const base = project.ssh ? project.ssh.remoteDir : project.directory
  if (!task.workspace) return base
  return [task.workspace.worktreePath, task.workspace.relativeProjectPath].filter(Boolean).join('/')
}

/**
 * Everything that has to happen to a task's tabs before the task itself is
 * deleted, when nobody is holding the window that owns them.
 *
 * A renderer only tears down tabs it has mounted — `AiToolTab` deliberately leaves
 * a hidden tab's PTY running in main — so none of this can be left to the windows
 * to notice. Whatever is skipped here is a leaked process, a stale scrollback file
 * or a hook left injected in someone's `.claude/settings.local.json`.
 */
export async function tearDownTaskTabs(
  project: Project,
  task: Task,
  targets: TaskTeardownTargets
): Promise<string[]> {
  const tabs = [...task.tabs.left, ...task.tabs.right]
  const dir = taskDir(project, task)

  for (const tab of tabs) {
    targets.killPty(tab.id)
    targets.deleteScrollback(tab.id)
    targets.forgetActivity(tab.id)
    // Only Claude injects hooks into a directory; pi loads an extension file and
    // the other tab types never inject at all.
    if (tab.type === 'claude') await targets.releaseHooks(project, dir, tab.id)
  }

  return tabs.map(tab => tab.id)
}

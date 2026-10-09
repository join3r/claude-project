import type { Project } from './types'

/**
 * What a DevTool server's project can do yet (plan steps 6 to 9). Terminals and
 * agent tabs run on the server from step 6; the rest still reach this desktop's
 * own files and processes, so they stay off for server projects until the step
 * that routes them flips its entry here. SSH and shell-command projects keep
 * their own guards (`isRemoteProject`, `isShellCommandProject`).
 */
export type ProjectFeature =
  /** The Files and Git panels, the file tree, git status polling. */
  | 'files'
  /** Editor, diff and notebook tabs (they read and write the project's files). */
  | 'editor'
  /** Notebook kernels. */
  | 'notebooks'
  /** The project's conda env, and the Browse… directory picker in Project settings. */
  | 'project-settings-local'
  /** A task's own worktree in a worktree stream, and landing it. */
  | 'task-worktrees'
  /** Claude chat tabs (the Agent SDK), and their /permissions. */
  | 'chat'
  /** Project Home's git posture and commit history. */
  | 'git-posture'
  /** Reveal in Finder and Open in IDE (this desktop's file manager and editors). */
  | 'local-folder'

const SERVER_FEATURES: Record<ProjectFeature, boolean> = {
  files: false, // step 7
  editor: false, // step 7
  notebooks: false, // step 7
  'project-settings-local': false, // step 7 (conda, server folder picker)
  'task-worktrees': false, // step 8
  chat: false, // step 7
  'git-posture': false, // step 7
  'local-folder': false // step 9 (Open in IDE over SSH); Reveal stays desktop-only
}

const STEP_REASON = 'Not available for projects on a DevTool server yet.'

/** Whether `feature` works for `project`; always for a project on this desktop. */
export function featureAvailable(project: Pick<Project, 'host'> | null | undefined, feature: ProjectFeature): boolean {
  if (!project?.host) return true
  return SERVER_FEATURES[feature]
}

/** Why `feature` is off for `project` (a tooltip), or null when it is on. */
export function featureUnavailableReason(project: Pick<Project, 'host'> | null | undefined, feature: ProjectFeature): string | null {
  return featureAvailable(project, feature) ? null : STEP_REASON
}

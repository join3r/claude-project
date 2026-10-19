/**
 * The worktree pre-flight behind closing a stream: the non-forced removal
 * already takes a clean, merged worktree (and its branch); anything else asks
 * keep branch / discard / cancel, and the forced pass runs once no process holds
 * the folder any more.
 */
import type { Project, WorkspaceConfig, WorkspaceDeleteResult } from '../../../shared/types'
import { getProjectDir } from '../../hooks/appState/projectsData'
import { worktreePreflight, worktreeRemovalFor, type WorktreeChoice } from './closeRules'

function deleteRequest(project: Project, workspace: WorkspaceConfig) {
  return {
    projectDir: getProjectDir(project),
    projectId: project.id,
    sshConfig: project.ssh,
    worktreePath: workspace.worktreePath,
    branchName: workspace.branchName,
    baseBranch: workspace.baseBranch
  }
}

export type AskWorktreeChoice = (question: {
  title: string
  message: string
  branch: string
  /** Offer the merge into this branch. */
  mergeInto?: string
  /** The branch has to stay (task branches kept off it). */
  mustKeepBranch?: boolean
}) => Promise<WorktreeChoice>

/**
 * Run the pre-flight and ask about whatever it found. Null means cancel; `done`
 * means the pre-flight already removed the worktree; otherwise the forced pass
 * still has to run, keeping the branch or not, after the merge into the base
 * branch when `merge` (offered when `canMerge` and the branch has commits the
 * base lacks). `keepBranch`: a clean, merged
 * worktree goes but its branch stays (its tasks kept branches off it, which a
 * reopen restores on top of it).
 */
export async function confirmWorktreeRemoval(
  project: Project,
  streamName: string,
  workspace: WorkspaceConfig,
  ask: AskWorktreeChoice,
  options: { keepBranch?: boolean; canMerge?: boolean } = {}
): Promise<{ done: true } | { done: false; keepBranch: boolean; merge: boolean } | null> {
  let result: WorkspaceDeleteResult
  try {
    result = await window.api.workspaceDelete({ ...deleteRequest(project, workspace), ...(options.keepBranch ? { keepBranch: true } : {}) })
  } catch (err) {
    // A pre-flight that never ran is not permission to delete: ask, like 'check-failed'.
    result = { status: 'check-failed', reason: err instanceof Error ? err.message : String(err) }
  }
  const outcome = worktreePreflight(result, workspace)
  if (outcome.kind === 'removed') return { done: true }
  if (outcome.kind === 'force') return { done: false, keepBranch: true, merge: false }
  const choice = await ask({
    title: `Close stream "${streamName}"?`,
    message: outcome.message,
    branch: workspace.branchName,
    ...(outcome.mergeable && options.canMerge ? { mergeInto: workspace.baseBranch } : {}),
    ...(options.keepBranch ? { mustKeepBranch: true } : {})
  })
  const removal = worktreeRemovalFor(choice)
  return removal ? { done: false, ...removal, keepBranch: removal.keepBranch || !!options.keepBranch } : null
}

/** The forced pass, once no process holds the worktree any more. */
export async function forceRemoveWorktree(project: Project, workspace: WorkspaceConfig, keepBranch: boolean): Promise<void> {
  try {
    const forced = await window.api.workspaceDelete({ ...deleteRequest(project, workspace), force: true, keepBranch })
    if (forced.status !== 'ok') {
      window.alert(forced.reason || `The workspace directory "${workspace.worktreePath}" could not be removed and was left on disk.`)
    }
  } catch {
    // The worktree may already be gone.
  }
}

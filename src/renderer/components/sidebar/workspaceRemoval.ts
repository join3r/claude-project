/**
 * The worktree pre-flight behind deleting a task or a stream from the sidebar:
 * ask about uncommitted or unmerged work first, then remove the worktree once
 * its tabs are gone. Step 6 moves this to stream archiving.
 */
import { isRemoteProject } from '../../../shared/types'
import type { Project, WorkspaceConfig, WorkspaceDeleteResult } from '../../../shared/types'
import { getProjectDir } from '../../hooks/appState/projectsData'

function deleteRequest(project: Project, workspace: WorkspaceConfig) {
  return {
    projectDir: getProjectDir(project),
    projectId: isRemoteProject(project) ? project.id : undefined,
    sshConfig: project.ssh,
    worktreePath: workspace.worktreePath,
    branchName: workspace.branchName,
    baseBranch: workspace.baseBranch
  }
}

/**
 * Run the pre-flight (which already removes a clean, merged worktree) and ask
 * about whatever it found. Null means cancel; otherwise whether to keep the branch.
 */
export async function confirmWorktreeRemoval(
  project: Project,
  workspace: WorkspaceConfig
): Promise<{ keepBranch: boolean } | null> {
  let result: WorkspaceDeleteResult
  try {
    result = await window.api.workspaceDelete(deleteRequest(project, workspace))
  } catch (err) {
    // A pre-flight that never ran is not permission to delete: ask, like 'check-failed'.
    result = { status: 'check-failed', reason: err instanceof Error ? err.message : String(err) }
  }

  let keepBranch = false
  if (result.status === 'uncommitted') {
    if (!window.confirm('This workspace has uncommitted changes that will be lost. Delete anyway?')) return null
  } else if (result.status === 'unmerged') {
    if (!window.confirm(`Branch "${workspace.branchName}" has not been merged into "${workspace.baseBranch}". Delete workspace?`)) return null
    keepBranch = !window.confirm(`Also delete the unmerged branch "${workspace.branchName}"?`)
  } else if (result.status === 'uncommitted-and-unmerged') {
    if (!window.confirm(`This workspace has uncommitted changes and branch "${workspace.branchName}" has not been merged into "${workspace.baseBranch}". Delete anyway?`)) return null
    keepBranch = !window.confirm(`Also delete the unmerged branch "${workspace.branchName}"?`)
  } else if (result.status === 'check-failed') {
    const reason = result.reason || 'The safety checks did not complete.'
    if (!window.confirm(`DevTool could not verify that workspace "${workspace.branchName}" is safe to delete.\n\n${reason}\n\nDelete anyway? Uncommitted or unmerged work may be lost.`)) return null
    // Merge state unknown, so keep the branch unless the user explicitly asks otherwise.
    keepBranch = !window.confirm(`Also delete the branch "${workspace.branchName}"? Its merge state could not be verified.`)
  }
  // 'invalid-worktree' is reported by the forced pass instead: killing the tabs
  // first can free the worktree, and that pass decides whether anything is left.
  return { keepBranch }
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

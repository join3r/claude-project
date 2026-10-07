import type { SshConfig, WorkspaceCreateRequest, WorkspaceDeleteRequest, WorkspaceDeleteResult, WorkspaceRestoreRequest, WorkspaceRestoreResult, WorkspaceTarget } from '../../shared/types'
import type { RemoteWorkspaceManager } from '../remote-workspace-manager'
import type { WorkspaceManager } from '../workspace-manager'
import type { IpcRegistrar } from './registrar'
import { workspaceCreateRequest, workspaceDeleteRequest, workspaceListBranchesRequest, workspaceRestoreRequest } from './schemas'

export interface WorkspaceDeps {
  workspaceManager: WorkspaceManager
  remoteWorkspaceManager: RemoteWorkspaceManager
  ensureSshConnected: (projectId: string, sshConfig: SshConfig) => Promise<void>
  socketPath: (projectId: string) => string
  /** Shared with main's own callers (a phone's new task cleanup). */
  deleteWorkspace: (request: WorkspaceDeleteRequest) => Promise<WorkspaceDeleteResult>
}

/**
 * Git worktree workspaces for tasks.
 *
 * `projectDir` is not allow-listed: the new-task composer lists branches and
 * creates a worktree for a directory picked with "Use a directory…" *before*
 * the ad-hoc project that will own it is written to the store, and a
 * cancelled create deletes a worktree no task ever recorded. Deletion is
 * guarded by WorkspaceManager itself (the path must be a registered worktree
 * of the repository).
 */
export function registerWorkspaceHandlers(ipc: IpcRegistrar, deps: WorkspaceDeps): void {
  ipc.handle('workspace-list-branches', [workspaceListBranchesRequest], (_event, request) => listWorkspaceBranches(deps, request))

  ipc.handle('workspace-create', [workspaceCreateRequest], (_event, request) => createWorkspace(deps, request))

  ipc.handle('workspace-delete', [workspaceDeleteRequest], (_event, request) => deps.deleteWorkspace(request))

  ipc.handle('workspace-restore', [workspaceRestoreRequest], (_event, request) => restoreWorkspace(deps, request))
}

type WorkspaceGit = Pick<WorkspaceDeps, 'workspaceManager' | 'remoteWorkspaceManager' | 'ensureSshConnected' | 'socketPath'>

/** The repository's local branches, over SSH for a remote project. Also used by the phone's `branches.list` and `stream.new`. */
export async function listWorkspaceBranches(deps: WorkspaceGit, request: WorkspaceTarget): Promise<string[]> {
  if (request.sshConfig && request.projectId) {
    await deps.ensureSshConnected(request.projectId, request.sshConfig)
    return deps.remoteWorkspaceManager.listBranches(deps.socketPath(request.projectId), {
      ...request,
      projectId: request.projectId,
      sshConfig: request.sshConfig
    })
  }
  return deps.workspaceManager.listBranches(request.projectDir)
}

/** A worktree on a new branch, over SSH for a remote project. Also used by the phone's `stream.new`. */
export async function createWorkspace(deps: WorkspaceGit, request: WorkspaceCreateRequest) {
  const { projectId, sshConfig } = request
  const result = sshConfig && projectId
    ? await (async () => {
        await deps.ensureSshConnected(projectId, sshConfig)
        return deps.remoteWorkspaceManager.create(deps.socketPath(projectId), {
          ...request,
          projectId,
          sshConfig
        })
      })()
    : await deps.workspaceManager.create(request.projectDir, request.name, request.baseBranch)
  return { ...result, baseBranch: request.baseBranch }
}

/** An archived stream's worktree back from its branch, over SSH for a remote project. */
export async function restoreWorkspace(deps: WorkspaceGit, request: WorkspaceRestoreRequest): Promise<WorkspaceRestoreResult> {
  const { projectId, sshConfig } = request
  if (sshConfig && projectId) {
    await deps.ensureSshConnected(projectId, sshConfig)
    return deps.remoteWorkspaceManager.restore(deps.socketPath(projectId), { ...request, projectId, sshConfig })
  }
  return deps.workspaceManager.restore(request.projectDir, request.worktreePath, request.branchName)
}

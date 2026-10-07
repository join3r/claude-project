import { randomUUID } from 'crypto'
import type { Project, ProjectsData, WorkspaceConfig, WorkspaceCreateRequest, WorkspaceTarget } from '../../shared/types'
import { AppErrorCode, type StreamNewParams } from '../../../protocol/ts/index.ts'
import { addStreamToProject, makeStreamWithId, streamDirectory, streamWorktreeSupported } from '../../shared/streams'
import { branchSlug, defaultBaseBranch } from '../../shared/branch-name'
import { isVisibleOnMobile } from './inbox'

/**
 * `stream.new` (SPEC.md §8.12): what the desktop's New stream dialog does on Create,
 * from the phone. A worktree stream gets its worktree first (`workspace-create`'s
 * own code, so over SSH too), then the stream goes at the end of the project's list
 * in a main-side commit; no window has to be open, and none switches to it.
 */

export type MobileOutcome<T> = { ok: true } & T | { ok: false; code: string; message: string }

/** The git side of the dialog: `listWorkspaceBranches` and `createWorkspace` (ipc/workspaces.ts). */
export interface StreamGit {
  listBranches(target: WorkspaceTarget): Promise<string[]>
  createWorkspace(request: WorkspaceCreateRequest): Promise<{ worktreePath: string; branchName: string; relativeProjectPath: string }>
}

export interface NewStreamDeps extends StreamGit {
  peek(): ProjectsData
  commit(data: ProjectsData): void
  ids?: () => string
}

/** A project the phone may see, or `not-found`. */
export function mobileProject(data: ProjectsData, projectId: string): MobileOutcome<{ project: Project }> {
  const project = data.projects.find((p) => p.id === projectId)
  if (!project || !isVisibleOnMobile(project)) return { ok: false, code: AppErrorCode.NotFound, message: 'No such project' }
  return { ok: true, project }
}

/** Where the dialog lists branches and makes worktrees: the project folder, remote over SSH. */
export function workspaceTarget(project: Project): WorkspaceTarget {
  return {
    projectDir: streamDirectory(project, undefined),
    projectId: project.ssh ? project.id : undefined,
    sshConfig: project.ssh
  }
}

const NO_WORKTREES = 'This project runs a shell command, so it has no folder to make a worktree in'

/** `branches.list` (SPEC.md §8.13): the dialog's From list and the branch it picks first. */
export async function listProjectBranches(
  deps: Pick<NewStreamDeps, 'peek' | 'listBranches'>,
  projectId: string
): Promise<MobileOutcome<{ branches: string[]; defaultBase: string }>> {
  const found = mobileProject(deps.peek(), projectId)
  if (!found.ok) return found
  if (!streamWorktreeSupported(found.project)) return { ok: false, code: AppErrorCode.Unsupported, message: NO_WORKTREES }
  const branches = await deps.listBranches(workspaceTarget(found.project))
  return { ok: true, branches, defaultBase: defaultBaseBranch(branches) }
}

export async function createStream(deps: NewStreamDeps, params: StreamNewParams): Promise<MobileOutcome<{ streamId: string }>> {
  const found = mobileProject(deps.peek(), params.projectId)
  if (!found.ok) return found
  const { project } = found
  let workspace: WorkspaceConfig | undefined
  if (params.worktree) {
    if (!streamWorktreeSupported(project)) return { ok: false, code: AppErrorCode.Unsupported, message: NO_WORKTREES }
    const branchName = params.branch ?? branchSlug(params.name)
    if (!branchName) return { ok: false, code: AppErrorCode.BadRequest, message: 'The stream needs a branch name' }
    const target = workspaceTarget(project)
    const baseBranch = params.baseBranch ?? defaultBaseBranch(await deps.listBranches(target))
    if (!baseBranch) {
      return { ok: false, code: AppErrorCode.Internal, message: 'No branch to fork a worktree from. Is this a git repository with a commit?' }
    }
    const result = await deps.createWorkspace({ ...target, name: branchName, baseBranch })
    workspace = {
      worktreePath: result.worktreePath,
      branchName: result.branchName,
      baseBranch,
      relativeProjectPath: result.relativeProjectPath
    }
  }
  const stream = makeStreamWithId((deps.ids ?? randomUUID)(), params.name, workspace)
  // Read again: git took a while, and the project may have changed (or gone) meanwhile.
  const data = deps.peek()
  const current = mobileProject(data, params.projectId)
  if (!current.ok) return current
  deps.commit({
    ...data,
    projects: data.projects.map((p) => (p === current.project ? addStreamToProject(p, stream) : p))
  })
  return { ok: true, streamId: stream.id }
}

import type { Project, ProjectsData, StreamMergeFixResult } from '../shared/types'
import { mapTaskInProject } from '../shared/streams'
import { addChatTaskToProject } from './mobile/new-task'

/**
 * A closing stream whose merge into its base branch conflicts (`stream-merge.ts`)
 * can have Claude resolve it: a new chat task in the stream, working in the
 * stream's own worktree (`sharesStreamWorktree`, so no worktree of its own and
 * nothing to land), is asked to merge the base branch into the stream's branch
 * and resolve the conflicts there. Closing the stream again then merges cleanly.
 */

export interface StreamMergeFixDeps {
  peek(): ProjectsData
  commit(data: ProjectsData): void
  /** Why the project can't start a Claude chat now, or null when it can. */
  blocker(project: Project): string | null
  /** Starts the chat tab's runtime and sends it the first prompt. */
  sendFirstPrompt(projectId: string, taskId: string, tabId: string, prompt: string): Promise<void>
  log(message: string): void
}

/** What the agent is asked: merge the base branch in, resolve, commit, and nothing that throws work away. */
export function streamMergeFixPrompt(options: { streamBranch: string; baseBranch: string; files: string[] }): string {
  return [
    `Merging this stream's branch \`${options.streamBranch}\` into \`${options.baseBranch}\` conflicts. Resolve it here, in this worktree (it has \`${options.streamBranch}\` checked out), by merging \`${options.baseBranch}\` into \`${options.streamBranch}\`.`,
    '',
    'Files that conflicted:',
    // Quoted: a file name is anyone's bytes, and odd ones show as escapes.
    ...(options.files.length > 0 ? options.files.map(file => `- ${JSON.stringify(file)}`) : ['- (the merge lists them)']),
    '',
    'Steps:',
    '1. Run `git status`. If the worktree has uncommitted changes, stop and tell me; don\'t commit, stash or discard them.',
    `2. Run \`git merge --no-edit ${JSON.stringify(options.baseBranch)}\`.`,
    '3. In each conflicted file, resolve every conflict (`<<<<<<<`, `=======`, `>>>>>>>`), keeping the intent of both sides.',
    '4. Run `git diff --check` and make sure no conflict markers or whitespace errors are left. Run the project\'s typecheck or tests if it has quick ones.',
    '5. `git add` the resolved files and finish the merge with `git commit --no-edit`.',
    '',
    'Never run `git reset --hard`, `git stash`, `git merge --abort`, `git rebase`, `git checkout`/`git switch` to another branch, or `git push`.',
    'Once the merge commit is made, stop and say so: closing the stream again merges it.'
  ].join('\n')
}

export async function startStreamMergeFix(deps: StreamMergeFixDeps, projectId: string, streamId: string, files: string[]): Promise<StreamMergeFixResult> {
  const data = deps.peek()
  const project = data.projects.find(p => p.id === projectId)
  const stream = project?.streams.find(candidate => candidate.id === streamId)
  if (!project || !stream) return { ok: false, error: 'No such stream.' }
  if (stream.isMain || !stream.workspace) return { ok: false, error: 'This stream has no branch of its own.' }
  const blocked = deps.blocker(project)
  if (blocked) return { ok: false, error: blocked }

  const { branchName, baseBranch } = stream.workspace
  const prompt = streamMergeFixPrompt({ streamBranch: branchName, baseBranch, files })
  const added = addChatTaskToProject(data, project, prompt, streamId)
  const name = `Merge ${baseBranch} into ${stream.name}`
  deps.commit({
    ...added.data,
    projects: added.data.projects.map(p => (p.id !== projectId ? p : mapTaskInProject(p, added.taskId, task => ({ ...task, name, sharesStreamWorktree: true }))))
  })
  // The task exists from here on, so a failed start is logged, not undone: the chat shows its own state.
  try {
    await deps.sendFirstPrompt(projectId, added.taskId, added.tabId, prompt)
  } catch (err) {
    deps.log(`stream merge fix start tab=${added.tabId} error=${err instanceof Error ? err.message : String(err)}`)
  }
  return { ok: true, taskId: added.taskId }
}

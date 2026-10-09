import fs from 'fs'
import path from 'path'
import { isAgentTabType } from '../shared/types'
import type {
  Project,
  ProjectsData,
  Stream,
  Tab,
  TabStatusValue,
  Task,
  TaskLanding,
  TaskLandingIntent,
  TaskLandingPreview,
  TaskLandingResult,
  WorkspaceConfig
} from '../shared/types'
import { findStreamOfTask, findTaskInProject, mapTaskInProject, projectTasks, taskTabs } from '../shared/streams'
import { joinWorkspaceDir } from '../shared/workspace-path'
import { gitErrorText, gitOutput, type GitResult, type GitRunner } from './git-runner'
import type { WorkspaceManager } from './workspace-manager'

/**
 * Landing a task's own worktree back into its stream: commit what is
 * uncommitted, squash the task's commits into one, rebase it onto a pinned
 * stream tip and fast-forward the stream's worktree to it. Then the task's
 * worktree and branch go (closing), or stay on the new stream tip (Land).
 *
 * Landings into one stream run one at a time, so two tasks never race for the
 * same fast-forward; different streams land in parallel. A landing that stops
 * leaves `Task.landing` (persisted, so a conflict survives a restart):
 *  - `conflict`: the rebase stopped in the task's worktree. Fix it there (or ask
 *    the task's agent to, {@link TaskLandingManager.fixWithAgent}), then retry;
 *    or abort, which puts the branch back as it was.
 *  - `blocked`: the stream's worktree has local changes in files the landing
 *    touches; git refused the fast-forward. Retry once they are committed.
 *
 * Conflicts are told by the `.git` state files (`rebase-merge/`,
 * `rebase-apply/`), never by git's output. DevTool's own commits, rebases and
 * merges run with `core.hooksPath=/dev/null`: the repo's hooks are for the
 * user's commits, and a slow pre-commit would stall every landing.
 */

export type TaskLandingGit = Pick<WorkspaceManager, 'delete'>

export interface TaskLandingDeps {
  /** Main's canonical projects: `commit` is app-runtime's one write path. */
  projects: {
    peek(): ProjectsData
    commit(next: ProjectsData): void
  }
  runner: GitRunner
  /** Removes worktrees (and their branches) the way closing a stream does. */
  git: TaskLandingGit
  /** Main's tab statuses (`TabActivityRegistry`). */
  activity: {
    getStatus(tabId: string): TabStatusValue
    subscribe(listener: (tabId: string) => void): () => void
  }
  /** Types `text` into an agent tab and submits it. Throws when it can't. */
  sendToAgent?(project: Project, task: Task, tab: Tab, text: string): Promise<void>
  /** The task's worktree is gone: forget anything kept about it (held setup, state). */
  forgetWorktree?(taskId: string): void
  /**
   * Ends the task's processes (terminals, agents) before its worktree is
   * removed: Windows won't delete a folder a process still runs in.
   */
  stopTabs?(project: Project, task: Task): Promise<void>
  /**
   * Archives a task whose close removed its worktree, as `closed` (no landing;
   * a `workspace` only when its branch was kept), its sessions being in `dir`.
   * Without it the task just loses its worktree and the caller archives.
   */
  archiveTask?(projectId: string, taskId: string, closed: Task, dir: string): Promise<void>
  /** `Task.landing` changed (it is also committed); null when cleared. */
  onState?(taskId: string, landing: TaskLanding | null): void
  /**
   * A landing resumed on its own (the agent asked to fix a conflict went idle
   * with the rebase done) came to `result`. A `close` that `landed` is archived
   * already (through `archiveTask`).
   */
  onResumed?(projectId: string, taskId: string, intent: TaskLandingIntent, result: TaskLandingResult): void
  log?(message: string): void
  /** Rebase-and-fast-forward rounds before giving up on a stream that keeps moving. */
  maxAttempts?: number
}

interface Located {
  project: Project
  stream: Stream
  task: Task
  /** The task's own worktree; landing git runs at its root, not the project's subfolder. */
  own: WorkspaceConfig
  /** The stream's worktree, which receives the fast-forward. */
  target: WorkspaceConfig
}

interface Watcher {
  tabId: string
  stop(): void
  /** A check of the git state is running; status changes meanwhile are dropped. */
  checking: boolean
}

type Rebased = { status: 'ok' } | { status: 'conflict' } | { status: 'failed'; error: string }

type FastForward =
  | { status: 'ok' }
  | { status: 'moved' }
  | { status: 'blocked'; files: string[]; message: string }

/** Kept out of DevTool's own git: hooks, and an editor for `rebase --continue`. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'] as const
const NO_EDITOR = { GIT_EDITOR: 'true' }
/** `add -A`, commit, rebase and merge can take a while in a big repo. */
const LONG_GIT_MS = 60_000
const MAX_ATTEMPTS = 3
/** Untracked paths setup commands left in a task worktree, in that worktree's own git dir. */
export const SETUP_ARTIFACTS_FILE = 'devtool-setup-artifacts.json'
/** DevTool's hooks file (`hook-injector.ts`); never committed, even when the repo tracks it. */
const HOOK_FILE = '.claude/settings.local.json'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function failed(error: string): TaskLandingResult {
  return { status: 'failed', error }
}

function splitNul(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

/** The paths of `git status --porcelain=v1 -z` (a rename's new path), with each entry's code. */
function porcelainEntries(out: string): { code: string; path: string }[] {
  const parts = out.split('\0')
  const entries: { code: string; path: string }[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    entries.push({ code, path: entry.slice(3) })
    // A rename or copy is followed by its source path.
    if (code[0] === 'R' || code[0] === 'C') i++
  }
  return entries
}

function isHookFile(file: string): boolean {
  return file === HOOK_FILE || file.endsWith(`/${HOOK_FILE}`)
}

/** A pathspec for exactly this path, whatever characters it has. */
function literal(file: string): string {
  return `:(literal)${file}`
}

async function absoluteGitDir(runner: GitRunner, root: string): Promise<string> {
  return (await gitOutput(runner, ['rev-parse', '--absolute-git-dir'], { cwd: root })).trim()
}

/**
 * Notes what setup commands left untracked in a fresh task worktree (a build
 * folder, a generated file), so landing doesn't commit it. The list lives in
 * the worktree's own git dir (`.git/worktrees/<name>/`) and goes with it.
 * Links and copies are in `info/exclude` already; this is for the commands.
 */
export async function recordSetupArtifacts(runner: GitRunner, worktreeRoot: string): Promise<void> {
  const gitDir = await absoluteGitDir(runner, worktreeRoot)
  const status = await gitOutput(runner, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: worktreeRoot })
  const untracked = porcelainEntries(status)
    .filter(entry => entry.code === '??')
    .map(entry => entry.path.replace(/\/$/, ''))
  fs.writeFileSync(path.join(gitDir, SETUP_ARTIFACTS_FILE), JSON.stringify(untracked))
}

function readSetupArtifacts(gitDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(gitDir, SETUP_ARTIFACTS_FILE), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
  } catch {
    return []
  }
}

/** The subject DevTool's commits get: the task's name. */
function commitSubject(task: Task): string {
  return task.name.trim() || 'Task'
}

/** The agent tab to ask for help: the task's main tab, else its first agent tab. */
function agentTabOf(task: Task): Tab | undefined {
  const tabs = taskTabs(task).filter(tab => isAgentTabType(tab.type))
  return tabs.find(tab => tab.id === task.mainTabId) ?? tabs[0]
}

/**
 * What the task's agent is asked when its landing stopped on conflicts
 * (adapted from Orca's conflict prompt): finish the rebase in place, and
 * nothing that would throw the user's work or the rebase away.
 */
export function conflictPrompt(options: { streamBranch: string; taskBranch: string; files: string[]; intent: TaskLandingIntent }): string {
  const after = options.intent === 'update'
    ? 'Once the rebase has finished, stop. Don\'t start other work.'
    : 'Once the rebase has finished, stop. DevTool lands the task into the stream on its own.'
  return [
    `Rebasing this task's branch \`${options.taskBranch}\` onto the stream branch \`${options.streamBranch}\` stopped on merge conflicts in this worktree.`,
    '',
    'Conflicted files:',
    // Quoted: a file name is anyone's bytes, and odd ones show as escapes.
    ...(options.files.length > 0 ? options.files.map(file => `- ${JSON.stringify(file)}`) : ['- (run `git status` to see them)']),
    '',
    'Resolve them:',
    '1. In each conflicted file, resolve every conflict (`<<<<<<<`, `=======`, `>>>>>>>`), keeping the intent of both sides.',
    '2. Run `git diff --check` and make sure no conflict markers or whitespace errors are left.',
    '3. `git add` the resolved files.',
    '4. Run `GIT_EDITOR=true git rebase --continue`.',
    '5. If the rebase stops on more conflicts, repeat until it finishes.',
    '',
    'Never run `git reset --hard`, `git stash`, `git rebase --abort`, `git checkout`/`git switch` to another branch, or `git push`.',
    after
  ].join('\n')
}

export class TaskLandingManager {
  /** The tail of each stream's queue (by stream id). */
  private readonly queues = new Map<string, Promise<void>>()
  /** Tasks with a call queued or running. */
  private readonly busy = new Set<string>()
  /** Tasks whose agent was asked to fix a conflict, by task id. */
  private readonly watchers = new Map<string, Watcher>()

  constructor(private readonly deps: TaskLandingDeps) {}

  /**
   * Lands the task into its stream. `keepWorktree` is the Land action: the
   * worktree stays, on the stream's new tip. Otherwise (closing) the task's
   * tabs stop, the worktree and branch go and the task is archived, also when
   * there was nothing to land.
   */
  landTask(projectId: string, taskId: string, options: { keepWorktree?: boolean } = {}): Promise<TaskLandingResult> {
    const intent: TaskLandingIntent = options.keepWorktree ? 'land' : 'close'
    return this.enqueue(projectId, taskId, at => this.land(at, intent))
  }

  /** Rebases the task onto the stream's tip without landing (its commits stay as they are). */
  updateFromStream(projectId: string, taskId: string): Promise<TaskLandingResult> {
    return this.enqueue(projectId, taskId, at => this.update(at))
  }

  /**
   * Picks a stopped landing up again: a conflict resolved by hand (staged, or
   * the rebase already continued) goes on; a blocked one tries the
   * fast-forward again. It ends the way it was asked for (`Task.landing.intent`).
   */
  retryLanding(projectId: string, taskId: string): Promise<TaskLandingResult> {
    return this.enqueue(projectId, taskId, async at => {
      const landing = at.task.landing
      if (!landing) return failed('Nothing to retry')
      if (this.agentWorking(at.task)) return { status: 'working' }
      this.stopWatching(taskId)
      return this.resume(at, landing.intent ?? 'close')
    })
  }

  /** Undoes a stopped rebase (`rebase --abort`) and clears the landing. The task stays as it was. */
  abortLanding(projectId: string, taskId: string): Promise<TaskLandingResult> {
    return this.enqueue(projectId, taskId, async at => {
      this.stopWatching(taskId)
      const root = at.own.worktreePath
      if (await this.rebaseInProgress(root)) {
        await this.deps.runner.run([...NO_HOOKS, 'rebase', '--abort'], { cwd: root, env: NO_EDITOR, timeoutMs: LONG_GIT_MS })
        if (await this.rebaseInProgress(root)) return failed('git could not abort the rebase')
      }
      this.setLanding(taskId, null)
      return { status: 'aborted' }
    })
  }

  /**
   * Asks the task's agent to resolve the conflict (`Task.landing` → `fixing`).
   * When the agent goes idle with the rebase finished, the landing resumes by
   * itself (an update just ends); with the rebase still stopped it is a
   * `conflict` again.
   */
  fixWithAgent(projectId: string, taskId: string): Promise<TaskLandingResult> {
    return this.enqueue(projectId, taskId, async at => {
      const intent = at.task.landing?.intent ?? 'close'
      const root = at.own.worktreePath
      // Resolved meanwhile: nothing to ask.
      if (!(await this.rebaseInProgress(root))) {
        this.stopWatching(taskId)
        return at.task.landing ? this.resume(at, intent) : failed('Nothing to fix')
      }
      const tab = agentTabOf(at.task)
      if (!tab) return failed('This task has no agent tab to ask')
      if (this.deps.activity.getStatus(tab.id) === 'working') return { status: 'working' }
      if (!this.deps.sendToAgent) return failed('Sending to the agent is not available')
      const files = await this.unmergedFiles(root)
      await this.deps.sendToAgent(at.project, at.task, tab, conflictPrompt({
        streamBranch: at.target.branchName,
        taskBranch: at.own.branchName,
        files,
        intent
      }))
      this.setLanding(taskId, { state: 'fixing', intent, files })
      this.watch(projectId, taskId, tab.id)
      return { status: 'fixing' }
    })
  }

  /** Commits on the stream since the task's branch last took it in ("<stream> +N"); null when unknown. */
  async streamAhead(projectId: string, taskId: string): Promise<number | null> {
    const at = this.locate(projectId, taskId)
    if (typeof at === 'string') return null
    const result = await this.deps.runner.run(
      ['rev-list', '--count', `refs/heads/${at.own.branchName}..refs/heads/${at.target.branchName}`],
      { cwd: at.own.worktreePath }
    )
    const count = Number.parseInt(result.stdout.trim(), 10)
    return result.code === 0 && Number.isFinite(count) ? count : null
  }

  /**
   * What closing would land (the close question's "Squash N commits…"); null
   * when it can't tell. Read only and not queued, like {@link streamAhead}.
   */
  async preview(projectId: string, taskId: string): Promise<TaskLandingPreview | null> {
    const at = this.locate(projectId, taskId)
    if (typeof at === 'string') return null
    const root = at.own.worktreePath
    try {
      const count = Number.parseInt(await this.git(root, ['rev-list', '--count', `refs/heads/${at.target.branchName}..HEAD`]), 10)
      const artifacts = readSetupArtifacts(await absoluteGitDir(this.deps.runner, root))
      // Every file, not collapsed folders: a new `.claude/` holding only the hooks file is nothing.
      const uncommitted = porcelainEntries(await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
        .map(entry => entry.path)
        .filter(file => !isHookFile(file) && !artifacts.some(entry => file === entry || file.startsWith(`${entry}/`)))
      return Number.isFinite(count) ? { commits: count, uncommitted: uncommitted.length } : null
    } catch {
      return null
    }
  }

  /**
   * Closing without landing; the task's tabs stop and it is archived. `keep`:
   * a stopped rebase is aborted, uncommitted work is committed, and the
   * worktree goes but the branch stays; so does `Task.workspace`, which tells a
   * reopen what to restore. `discard`: worktree and branch go, uncommitted work
   * with them, and `Task.workspace` is cleared.
   *
   * `archive: false` is for a stream about to close with its tasks: the task
   * stays where it is and keeps `Task.workspace` either way, as the record of
   * where it worked. Reopened, it gets the worktree back from the branch, or a
   * fresh one when the branch went.
   */
  closeWorktree(projectId: string, taskId: string, mode: 'keep' | 'discard', options: { archive?: boolean } = {}): Promise<TaskLandingResult> {
    return this.enqueue(projectId, taskId, async at => {
      this.stopWatching(taskId)
      if (mode === 'keep') {
        const root = at.own.worktreePath
        if (await this.rebaseInProgress(root)) {
          await this.deps.runner.run([...NO_HOOKS, 'rebase', '--abort'], { cwd: root, env: NO_EDITOR, timeoutMs: LONG_GIT_MS })
          if (await this.rebaseInProgress(root)) return failed('git could not abort the rebase, so the worktree was kept')
        }
        await this.autoCommit(at)
      }
      await this.remove(at, { keepBranch: mode === 'keep', archive: options.archive !== false })
      return { status: 'removed' }
    })
  }

  /**
   * At startup: a persisted landing is matched against git. A rebase still
   * stopped is a `conflict` (whatever it was, `fixing` included: no agent is
   * being watched any more); anything else is cleared.
   */
  async reconcile(): Promise<void> {
    for (const project of this.deps.projects.peek().projects) {
      for (const task of projectTasks(project)) {
        if (!task.landing) continue
        try {
          const root = task.workspace?.worktreePath
          if (!root || !fs.existsSync(root) || !(await this.rebaseInProgress(root))) {
            this.setLanding(task.id, null)
            continue
          }
          const files = await this.unmergedFiles(root)
          this.setLanding(task.id, { state: 'conflict', intent: task.landing.intent ?? 'close', files })
        } catch (err) {
          this.deps.log?.(`task landing reconcile task=${task.id} error=${errorMessage(err)}`)
        }
      }
    }
  }

  // ---- the steps -------------------------------------------------------------------

  private async land(at: Located, intent: TaskLandingIntent): Promise<TaskLandingResult> {
    if (this.agentWorking(at.task)) return { status: 'working' }
    this.stopWatching(at.task.id)
    const root = at.own.worktreePath
    // A landing that already stopped: retry or abort it, don't stack another.
    if (await this.rebaseInProgress(root)) return this.conflict(at, at.task.landing?.intent ?? intent)
    this.setLanding(at.task.id, { state: 'landing', intent })
    await this.autoCommit(at)
    const base = (await this.git(root, ['merge-base', `refs/heads/${at.target.branchName}`, 'HEAD'])).trim()
    if (!(await this.squash(at, base))) {
      this.deps.log?.(`task landing task=${at.task.id} nothing to land`)
      if (intent === 'close') await this.remove(at, { keepBranch: false, archive: true })
      else this.setLanding(at.task.id, null)
      return { status: 'nothing' }
    }
    return this.integrate(at, intent)
  }

  private async update(at: Located): Promise<TaskLandingResult> {
    if (this.agentWorking(at.task)) return { status: 'working' }
    this.stopWatching(at.task.id)
    const root = at.own.worktreePath
    if (await this.rebaseInProgress(root)) return this.conflict(at, at.task.landing?.intent ?? 'update')
    this.setLanding(at.task.id, { state: 'landing', intent: 'update' })
    await this.autoCommit(at)
    const tip = await this.streamTip(at)
    const contains = await this.deps.runner.run(['merge-base', '--is-ancestor', tip, 'HEAD'], { cwd: root })
    if (contains.code === 0) {
      this.setLanding(at.task.id, null)
      return { status: 'nothing' }
    }
    const rebased = await this.rebase(at, tip)
    if (rebased.status === 'conflict') return this.conflict(at, 'update')
    this.setLanding(at.task.id, null)
    return rebased.status === 'failed' ? failed(rebased.error) : { status: 'updated' }
  }

  /** Where a stopped landing goes on from: the rebase (if it is still stopped), then the rest. */
  private async resume(at: Located, intent: TaskLandingIntent): Promise<TaskLandingResult> {
    const root = at.own.worktreePath
    if (await this.rebaseInProgress(root)) {
      if ((await this.unmergedFiles(root)).length > 0) return this.conflict(at, intent)
      this.setLanding(at.task.id, { state: 'landing', intent })
      const continued = await this.deps.runner.run([...NO_HOOKS, 'rebase', '--continue'], { cwd: root, env: NO_EDITOR, timeoutMs: LONG_GIT_MS })
      if (await this.rebaseInProgress(root)) return this.conflict(at, intent)
      if (continued.code !== 0) {
        this.setLanding(at.task.id, null)
        return failed(gitErrorText(['rebase', '--continue'], continued))
      }
    }
    if (intent === 'update') {
      this.setLanding(at.task.id, null)
      return { status: 'updated' }
    }
    this.setLanding(at.task.id, { state: 'landing', intent })
    return this.integrate(at, intent)
  }

  /**
   * Rebase onto a pinned stream tip, then fast-forward the stream to the
   * result. A stream that moved in between (another task, a commit in its
   * worktree) means another round.
   */
  private async integrate(at: Located, intent: TaskLandingIntent): Promise<TaskLandingResult> {
    const attempts = this.deps.maxAttempts ?? MAX_ATTEMPTS
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const pinned = await this.streamTip(at)
      const rebased = await this.rebase(at, pinned)
      if (rebased.status === 'conflict') return this.conflict(at, intent)
      if (rebased.status === 'failed') {
        this.setLanding(at.task.id, null)
        return failed(rebased.error)
      }
      const ff = await this.fastForward(at, pinned)
      if (ff.status === 'moved') {
        this.deps.log?.(`task landing task=${at.task.id} stream moved, attempt=${attempt}`)
        continue
      }
      if (ff.status === 'blocked') {
        this.setLanding(at.task.id, { state: 'blocked', intent, files: ff.files, message: ff.message })
        return { status: 'blocked', files: ff.files, message: ff.message }
      }
      this.deps.log?.(`task landing task=${at.task.id} landed into ${at.target.branchName}`)
      if (intent === 'close') await this.remove(at, { keepBranch: false, archive: true })
      else this.setLanding(at.task.id, null)
      return { status: 'landed' }
    }
    this.setLanding(at.task.id, null)
    return failed(`${at.target.branchName} kept moving while the task was landing. Try again.`)
  }

  /**
   * `add -A` and a commit named after the task, without DevTool's hooks file
   * and without what setup commands left behind. False when there was nothing
   * (else) to commit.
   */
  private async autoCommit(at: Located): Promise<boolean> {
    const root = at.own.worktreePath
    if (!(await this.git(root, ['status', '--porcelain=v1', '-z']))) return false
    await this.git(root, ['add', '-A'], LONG_GIT_MS)
    const staged = splitNul(await this.git(root, ['diff', '--cached', '--name-only', '-z']))
    const artifacts = readSetupArtifacts(await absoluteGitDir(this.deps.runner, root))
    const keepOut = new Set<string>()
    for (const file of staged) {
      if (isHookFile(file)) keepOut.add(file)
      const artifact = artifacts.find(entry => file === entry || file.startsWith(`${entry}/`))
      if (artifact) keepOut.add(artifact)
    }
    if (keepOut.size > 0) await this.git(root, ['reset', '-q', '--', ...[...keepOut].map(literal)])
    if (!(await this.hasStaged(root))) return false
    await this.commit(root, commitSubject(at.task))
    return true
  }

  /**
   * The task's commits since `base` as one: subject = the task's name, body =
   * the squashed commits' subjects. A commit already named after the task (an
   * auto-commit, an earlier squash) adds its own bullets instead. False when
   * there is nothing to land.
   */
  private async squash(at: Located, base: string): Promise<boolean> {
    const root = at.own.worktreePath
    const log = await this.git(root, ['log', '--reverse', '--format=%s%x1f%b%x1e', `${base}..HEAD`])
    const commits = log.split('\x1e')
      .map(entry => entry.replace(/^\n/, ''))
      .filter(Boolean)
      .map(entry => {
        const [subject, body = ''] = entry.split('\x1f')
        return { subject, body }
      })
    if (commits.length === 0) return false
    const subject = commitSubject(at.task)
    if (commits.length === 1 && commits[0].subject === subject) return true
    const bullets = commits.flatMap(commit => commit.subject === subject
      ? commit.body.split('\n').filter(line => line.startsWith('- '))
      : [`- ${commit.subject}`])
    await this.git(root, ['reset', '-q', '--soft', base])
    // The commits undid each other.
    if (!(await this.hasStaged(root))) return false
    await this.commit(root, subject, bullets.join('\n'))
    return true
  }

  private async rebase(at: Located, onto: string): Promise<Rebased> {
    const root = at.own.worktreePath
    // --autostash: a tracked hooks file DevTool left out of the commit is still dirty.
    const result = await this.deps.runner.run([...NO_HOOKS, 'rebase', '--autostash', onto], { cwd: root, env: NO_EDITOR, timeoutMs: LONG_GIT_MS })
    if (await this.rebaseInProgress(root)) return { status: 'conflict' }
    if (result.code !== 0) return { status: 'failed', error: gitErrorText(['rebase'], result) }
    return { status: 'ok' }
  }

  private async fastForward(at: Located, pinned: string): Promise<FastForward> {
    const streamRoot = at.target.worktreePath
    const branch = at.target.branchName
    const head = await this.deps.runner.run(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: streamRoot })
    if (head.stdout.trim() !== branch) {
      return { status: 'blocked', files: [], message: `The stream's worktree is not on ${branch}` }
    }
    const merged = await this.deps.runner.run(
      [...NO_HOOKS, 'merge', '--ff-only', '--no-verify-signatures', `refs/heads/${at.own.branchName}`],
      { cwd: streamRoot, timeoutMs: LONG_GIT_MS }
    )
    if (merged.code === 0) return { status: 'ok' }
    if ((await this.streamTip(at)) !== pinned) return { status: 'moved' }
    // Not moved, so git refused over the worktree: name the files in the way.
    const dirty = new Set(porcelainEntries(await this.git(streamRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).map(entry => entry.path))
    const landing = splitNul(await this.git(streamRoot, ['diff', '--name-only', '-z', pinned, `refs/heads/${at.own.branchName}`]))
    return { status: 'blocked', files: landing.filter(file => dirty.has(file)), message: gitErrorText(['merge'], merged) }
  }

  /**
   * Closing: the task's tabs stop, the worktree goes (and the branch, unless
   * kept), and the task is archived in the same step that drops its worktree
   * from the data. A window never sees it open without a worktree, which
   * would make it a new one. `archive: false` leaves the task in place with
   * `Task.workspace` kept as the record of its worktree (its stream closes next).
   */
  private async remove(at: Located, options: { keepBranch: boolean; archive: boolean }): Promise<void> {
    const dir = joinWorkspaceDir(at.own.worktreePath, at.own.relativeProjectPath)
    await this.deps.stopTabs?.(at.project, at.task)
    const removed = await this.deps.git.delete({
      projectDir: at.project.directory,
      worktreePath: at.own.worktreePath,
      branchName: at.own.branchName,
      baseBranch: at.own.baseBranch,
      force: true,
      keepBranch: options.keepBranch
    })
    if (removed.status !== 'ok') throw new Error(removed.reason ?? `Couldn't remove the task's worktree (${removed.status})`)
    await this.deps.runner.run(['worktree', 'prune'], { cwd: at.project.directory })
    this.deps.forgetWorktree?.(at.task.id)
    const keepRecord = options.keepBranch || !options.archive
    const closed = (task: Task): Task => {
      const { landing: _landing, workspace, ...rest } = task
      return keepRecord && workspace ? { ...rest, workspace } : rest
    }
    if (options.archive && this.deps.archiveTask) {
      const latest = findTaskInProject(this.deps.projects.peek().projects.find(p => p.id === at.project.id), at.task.id) ?? at.task
      await this.deps.archiveTask(at.project.id, at.task.id, closed(latest), dir)
      this.deps.onState?.(at.task.id, null)
      return
    }
    if (this.mapTask(at.task.id, closed)) this.deps.onState?.(at.task.id, null)
  }

  private async conflict(at: Located, intent: TaskLandingIntent): Promise<TaskLandingResult> {
    const files = await this.unmergedFiles(at.own.worktreePath)
    this.setLanding(at.task.id, { state: 'conflict', intent, files })
    return { status: 'conflict', files }
  }

  // ---- the agent fixing a conflict ---------------------------------------------------

  /**
   * Waits for the tab's turn to end: a status leaving `working` (Stop, the
   * process gone). An agent waiting on the user (`attention`) with the rebase
   * still stopped is left to it.
   */
  private watch(projectId: string, taskId: string, tabId: string): void {
    this.stopWatching(taskId)
    let sawWorking = this.deps.activity.getStatus(tabId) === 'working'
    const watcher: Watcher = {
      tabId,
      checking: false,
      stop: this.deps.activity.subscribe(changed => {
        if (changed !== tabId || watcher.checking) return
        const status = this.deps.activity.getStatus(tabId)
        if (status === 'working') {
          sawWorking = true
          return
        }
        if (!sawWorking) return
        sawWorking = false
        watcher.checking = true
        void this.agentStopped(projectId, taskId, status)
          .catch(err => this.deps.log?.(`task landing fix task=${taskId} error=${errorMessage(err)}`))
          .finally(() => { watcher.checking = false })
      })
    }
    this.watchers.set(taskId, watcher)
  }

  private stopWatching(taskId: string): void {
    const watcher = this.watchers.get(taskId)
    if (!watcher) return
    watcher.stop()
    this.watchers.delete(taskId)
  }

  private async agentStopped(projectId: string, taskId: string, status: TabStatusValue): Promise<void> {
    const at = this.locate(projectId, taskId)
    if (typeof at === 'string' || at.task.landing?.state !== 'fixing') {
      this.stopWatching(taskId)
      return
    }
    const intent = at.task.landing.intent ?? 'close'
    if (await this.rebaseInProgress(at.own.worktreePath)) {
      if (status === 'attention') return
      this.stopWatching(taskId)
      await this.conflict(at, intent)
      return
    }
    this.stopWatching(taskId)
    this.deps.log?.(`task landing task=${taskId} agent finished the rebase, resuming ${intent}`)
    const result = await this.enqueue(projectId, taskId, current => this.resume(current, current.task.landing?.intent ?? intent))
    this.deps.onResumed?.(projectId, taskId, intent, result)
  }

  // ---- plumbing --------------------------------------------------------------------

  /**
   * Runs `run` after everything already queued for the task's stream. A task
   * with a call already queued or running gets a `failed` at once. Whatever
   * throws comes back as `failed`, with a `landing` state cleared.
   */
  private enqueue(projectId: string, taskId: string, run: (at: Located) => Promise<TaskLandingResult>): Promise<TaskLandingResult> {
    const found = this.locate(projectId, taskId)
    if (typeof found === 'string') return Promise.resolve(failed(found))
    if (this.busy.has(taskId)) return Promise.resolve(failed('This task is already landing'))
    this.busy.add(taskId)
    const key = found.stream.id
    const previous = this.queues.get(key) ?? Promise.resolve()
    const result = previous
      .then(async () => {
        // Re-read: the queue may have waited a while.
        const at = this.locate(projectId, taskId)
        return typeof at === 'string' ? failed(at) : run(at)
      })
      .catch((err: unknown) => {
        const error = errorMessage(err)
        this.deps.log?.(`task landing task=${taskId} error=${error}`)
        const located = this.locate(projectId, taskId)
        if (typeof located !== 'string' && located.task.landing?.state === 'landing') this.setLanding(taskId, null)
        return failed(error)
      })
      .finally(() => this.busy.delete(taskId))
    const tail = result.then(() => undefined)
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return result
  }

  /** The task with both worktrees, or why it can't land. */
  private locate(projectId: string, taskId: string): Located | string {
    const project = this.deps.projects.peek().projects.find(p => p.id === projectId)
    const stream = findStreamOfTask(project, taskId)
    const task = findTaskInProject(project, taskId)
    if (!project || !stream || !task) return 'No such task'
    if (project.ssh) return 'Landing is not supported for SSH projects yet'
    if (!task.workspace) return 'This task has no worktree of its own'
    if (!stream.workspace) return 'The task\'s stream has no worktree'
    return { project, stream, task, own: task.workspace, target: stream.workspace }
  }

  /** The sidebar's `isTaskWorking`: an agent tab mid-turn. Terminals don't count (a dev server never stops). */
  private agentWorking(task: Task): boolean {
    return taskTabs(task).some(tab => isAgentTabType(tab.type) && this.deps.activity.getStatus(tab.id) === 'working')
  }

  private async rebaseInProgress(root: string): Promise<boolean> {
    const gitDir = await absoluteGitDir(this.deps.runner, root)
    return fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))
  }

  private async unmergedFiles(root: string): Promise<string[]> {
    return splitNul(await this.git(root, ['diff', '--name-only', '-z', '--diff-filter=U']))
  }

  private async streamTip(at: Located): Promise<string> {
    return (await this.git(at.target.worktreePath, ['rev-parse', '--verify', '-q', `refs/heads/${at.target.branchName}`])).trim()
  }

  private async hasStaged(root: string): Promise<boolean> {
    const result: GitResult = await this.deps.runner.run(['diff', '--cached', '--quiet'], { cwd: root })
    if (result.code === 0) return false
    if (result.code === 1) return true
    throw new Error(gitErrorText(['diff', '--cached'], result))
  }

  private async commit(root: string, subject: string, body?: string): Promise<void> {
    await this.git(root, [...NO_HOOKS, 'commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])], LONG_GIT_MS)
  }

  private git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
    return gitOutput(this.deps.runner, args, { cwd, timeoutMs })
  }

  private setLanding(taskId: string, landing: TaskLanding | null): void {
    const changed = this.mapTask(taskId, task => {
      if (landing) return { ...task, landing }
      if (!task.landing) return task
      const { landing: _landing, ...rest } = task
      return rest
    })
    if (changed) this.deps.onState?.(taskId, landing)
  }

  /** `fn` on the task wherever main has it, committed when it changed anything. */
  private mapTask(taskId: string, fn: (task: Task) => Task): boolean {
    const data = this.deps.projects.peek()
    let changed = false
    const projects = data.projects.map(project => {
      if (!findTaskInProject(project, taskId)) return project
      const next = mapTaskInProject(project, taskId, fn)
      if (next !== project) changed = true
      return next
    })
    if (changed) this.deps.projects.commit({ ...data, projects })
    return changed
  }
}

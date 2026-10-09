import fs from 'fs'
import type {
  EnsureTaskWorktreeOptions,
  PendingWorktreeSetup,
  Project,
  ProjectsData,
  Stream,
  StreamSetupResult,
  Task,
  TaskWorktreeResult,
  TaskWorktreeState,
  WorkspaceConfig,
  WorkspaceRestoreResult,
  WorktreeSetupDecision
} from '../shared/types'
import { findStreamOfTask, findTaskInProject, mapTaskInProject, needsTaskWorktree, taskWorktreesSupported } from '../shared/streams'
import { taskBranchName } from '../shared/branch-name'
import type { WorkspaceManager } from './workspace-manager'
import type { WorktreeSetupResult } from './worktree-setup'

/**
 * A task's own worktree, made lazily: the first time something is about to
 * spawn in the task (a window mounting its tabs, a phone's `task.new` or chat),
 * on a branch `<stream>--<task slug>` off the stream's branch, next to the
 * stream's worktree, with the repo's `.devtool/worktree.json` setup taken from
 * the stream's worktree. One creation per task at a time; everyone who asks
 * meanwhile gets the same answer.
 *
 * A reopened task can bring the worktree it had recorded (closed with Keep
 * branch, or with its stream): its folder is gone, so it comes back from the
 * branch, setup included, or as a fresh worktree when the branch went too.
 *
 * Progress is a per-task {@link TaskWorktreeState}, pushed to the windows so a
 * task shows "Preparing worktree…", the setup approval or an error wherever it
 * is on screen.
 */

export type TaskWorktreeGit = Pick<WorkspaceManager, 'listBranches' | 'create' | 'restore' | 'runSetup' | 'approveSetup' | 'delete' | 'repoRoot'>

export interface TaskWorktreeDeps {
  /** Main's canonical projects: `commit` is app-runtime's one write path. */
  projects: {
    peek(): ProjectsData
    commit(next: ProjectsData): void
    subscribe(listener: () => void): () => void
  }
  git: TaskWorktreeGit
  /** A task's state changed; null when it has none any more. */
  onState?(taskId: string, state: TaskWorktreeState | null): void
  log?(message: string): void
  /**
   * Setup commands finished in a new task worktree: note what they left
   * untracked, so landing doesn't commit it (`recordSetupArtifacts` in task-landing.ts).
   */
  recordSetupArtifacts?(worktreeRoot: string): Promise<void>
  /** How long to wait for a window's save to bring a task main does not know yet. */
  waitMs?: number
  /** Whether a worktree folder is there (`fs.existsSync`). */
  exists?(path: string): boolean
  /**
   * A landing call is queued or running for the task (`TaskLandingManager.isBusy`).
   * A close removes the worktree before it archives the task, so a folder gone
   * meanwhile is not one to restore.
   */
  isLanding?(taskId: string): boolean
}

interface Located {
  project: Project
  stream: Stream
  task: Task
}

/** A made worktree whose setup commands wait for the user's answer. */
interface HeldSetup {
  workspace: WorkspaceConfig
  pending: PendingWorktreeSetup
  sourceRoot: string
  worktreeRoot: string
}

/** A window adds a task and its first tab before its save reaches main. */
const WAIT_FOR_SAVE_MS = 10_000
/** Setup output a window gets to show, from the end. */
const LOG_TAIL_CHARS = 4000
/** Output streams in; windows get it at most this often. */
const LOG_PUBLISH_MS = 250

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class TaskWorktreeManager {
  private readonly inflight = new Map<string, Promise<TaskWorktreeResult>>()
  private readonly states = new Map<string, TaskWorktreeState>()
  private readonly held = new Map<string, HeldSetup>()
  private readonly publishTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: TaskWorktreeDeps) {}

  /**
   * Makes the task's worktree if it is still to get one, and records it as
   * `Task.workspace`. Safe to call for any task: one that has a worktree, or
   * works in its stream's directory, answers at once. A recorded worktree
   * whose folder is gone is restored from its branch (see {@link restore}).
   *
   * A git failure leaves nothing behind and nothing to spawn in (`failed`).
   * A failed setup step keeps the worktree (`ready` with `setupError`); setup
   * commands not approved yet keep it too (`needs-approval`): answer with
   * {@link decideSetup}.
   */
  ensureTaskWorktree(projectId: string, taskId: string, options: EnsureTaskWorktreeOptions = {}): Promise<TaskWorktreeResult> {
    return this.single(taskId, () => this.ensure(projectId, taskId, options))
  }

  /**
   * The user's answer to a task's held setup: `run` approves this exact
   * config for the repo and runs the commands, `skip` lets the task start
   * without them.
   */
  decideSetup(taskId: string, decision: WorktreeSetupDecision): Promise<TaskWorktreeResult> {
    if (this.inflight.has(taskId)) return this.inflight.get(taskId)!
    const held = this.held.get(taskId)
    if (!held) return Promise.resolve(this.current(taskId))
    return this.single(taskId, () => this.runHeld(taskId, held, decision))
  }

  /** Clears a shown error (`failed`, `setup-failed`). */
  dismiss(taskId: string): void {
    const phase = this.states.get(taskId)?.phase
    if (phase === 'failed' || phase === 'setup-failed') this.setState(taskId, null)
  }

  /** The task's worktree is gone (landed, kept as a branch, discarded): drop its held setup and state. */
  forget(taskId: string): void {
    this.held.delete(taskId)
    this.setState(taskId, null)
  }

  /** Every task with a state, for a window that just loaded. */
  getStates(): Record<string, TaskWorktreeState> {
    return Object.fromEntries(this.states)
  }

  /**
   * The New stream dialog's approval: approve this config for the repo and
   * run the setup in the stream's worktree, from the project's checkout.
   */
  async runStreamSetup(projectId: string, streamId: string, pending: PendingWorktreeSetup): Promise<StreamSetupResult> {
    const located = await this.waitFor(() => {
      const project = this.deps.projects.peek().projects.find(p => p.id === projectId)
      const stream = project?.streams.find(s => s.id === streamId)
      return project && stream ? { project, stream } : null
    })
    const workspace = located?.stream.workspace
    if (!located || !workspace || !taskWorktreesSupported(located.project)) return { status: 'failed', error: 'No such stream worktree' }
    this.deps.git.approveSetup(pending.repoKey, pending.hash)
    try {
      const sourceRoot = await this.deps.git.repoRoot(located.project.directory)
      const setup = await this.deps.git.runSetup({ sourceRoot, worktreeRoot: workspace.worktreePath, branch: workspace.branchName })
      if (setup.status === 'failed') return { status: 'failed', error: setup.error }
      if (setup.status === 'needs-approval') return { status: 'needs-approval', pending: setup.pending }
      return { status: 'ok' }
    } catch (err) {
      return { status: 'failed', error: errorMessage(err) }
    }
  }

  private single(taskId: string, run: () => Promise<TaskWorktreeResult>): Promise<TaskWorktreeResult> {
    const running = this.inflight.get(taskId)
    if (running) return running
    const promise = run().finally(() => this.inflight.delete(taskId))
    this.inflight.set(taskId, promise)
    return promise
  }

  private async ensure(projectId: string, taskId: string, options: EnsureTaskWorktreeOptions): Promise<TaskWorktreeResult> {
    const found = await this.waitFor(() => {
      const located = this.find(projectId, taskId)
      return located && (!options.streamId || located.stream.id === options.streamId) ? located : null
    }, () => this.find(projectId, taskId))
    if (!found) return { status: 'failed', error: 'No such task' }
    const { project, stream, task } = found
    if (task.workspace) {
      if (!this.isGone(found, task.workspace)) return this.current(taskId)
      // Closing: the archive follows, and a worktree made now would be left behind.
      if (this.deps.isLanding?.(taskId)) return { status: 'failed', error: 'The task is being closed' }
      return this.restore(found, task.workspace, options)
    }
    if (!needsTaskWorktree(project, stream, task) || !stream.workspace) return { status: 'not-needed' }
    return this.create(found, stream.workspace, options)
  }

  /** A new worktree and branch off the stream's tip, then setup. */
  private async create(found: Located, base: WorkspaceConfig, options: EnsureTaskWorktreeOptions): Promise<TaskWorktreeResult> {
    const { project, stream, task } = found
    const projectId = project.id
    const taskId = task.id

    this.setState(taskId, { phase: 'creating' })
    let created: Awaited<ReturnType<TaskWorktreeGit['create']>>
    try {
      const branches = await this.deps.git.listBranches(project.directory)
      // The latest name: a prompt box renames the task as it adds the first tab.
      const name = options.name?.trim() || (this.find(projectId, taskId)?.task.name ?? task.name)
      const branch = taskBranchName(base.branchName, name, branches)
      this.setState(taskId, { phase: 'creating', branch })
      created = await this.deps.git.create(project.directory, branch, base.branchName, {
        setupSource: base.worktreePath,
        onSetupOutput: (text) => this.appendLog(taskId, text)
      })
    } catch (err) {
      const error = errorMessage(err)
      this.deps.log?.(`task worktree task=${taskId} error=${error}`)
      this.setState(taskId, { phase: 'failed', error })
      return { status: 'failed', error }
    }
    const workspace: WorkspaceConfig = {
      worktreePath: created.worktreePath,
      branchName: created.branchName,
      baseBranch: base.branchName,
      relativeProjectPath: created.relativeProjectPath
    }

    // Git took a while: the task may have been closed or moved meanwhile.
    const now = this.find(projectId, taskId)
    if (!now || now.stream.id !== stream.id || now.task.workspace) {
      await this.discard(project, workspace)
      if (now?.task.workspace) return this.current(taskId)
      if (!now) {
        this.setState(taskId, null)
        return { status: 'failed', error: 'The task was closed' }
      }
      const error = 'The task moved to another stream while its worktree was being made'
      this.setState(taskId, { phase: 'failed', error })
      return { status: 'failed', error }
    }
    this.commitTask(projectId, taskId, t => ({ ...t, workspace }))
    this.deps.log?.(`task worktree task=${taskId} branch=${workspace.branchName} setup=${created.setup.status}`)
    return this.afterSetup(taskId, workspace, created.setup, { sourceRoot: base.worktreePath, worktreeRoot: created.worktreePath })
  }

  /** A recorded worktree of a task in a task-worktree stream (not over SSH), whose folder is not there. */
  private isGone(found: Located, recorded: WorkspaceConfig): boolean {
    const { project, stream } = found
    if (!taskWorktreesSupported(project) || !stream.workspace || !stream.taskWorktrees) return false
    return !(this.deps.exists ?? fs.existsSync)(recorded.worktreePath)
  }

  /**
   * The recorded worktree back from its branch (`git worktree add <path>
   * <branch>`), then setup again: links, copies, and the commands once
   * approved. When the branch is gone the record goes and the task gets a
   * fresh worktree off the stream's tip, as a new task would.
   */
  private async restore(found: Located, recorded: WorkspaceConfig, options: EnsureTaskWorktreeOptions): Promise<TaskWorktreeResult> {
    const { project, stream, task } = found
    const base = stream.workspace!
    this.setState(task.id, { phase: 'creating', branch: recorded.branchName })
    let restored: WorkspaceRestoreResult
    try {
      restored = await this.deps.git.restore(project.directory, recorded.worktreePath, recorded.branchName)
    } catch (err) {
      const error = errorMessage(err)
      this.deps.log?.(`task worktree restore task=${task.id} error=${error}`)
      this.setState(task.id, { phase: 'failed', error })
      return { status: 'failed', error }
    }
    if (restored.status === 'branch-missing') {
      this.deps.log?.(`task worktree task=${task.id} branch ${recorded.branchName} is gone, making a fresh worktree`)
      this.commitTask(project.id, task.id, current => {
        const { workspace: _gone, ...rest } = current
        return rest
      })
      const now = this.find(project.id, task.id)
      if (!now?.stream.workspace || !needsTaskWorktree(now.project, now.stream, now.task)) {
        this.setState(task.id, null)
        return now ? { status: 'not-needed' } : { status: 'failed', error: 'The task was closed' }
      }
      return this.create(now, now.stream.workspace, options)
    }
    const workspace: WorkspaceConfig = {
      worktreePath: restored.worktreePath,
      branchName: restored.branchName,
      baseBranch: base.branchName,
      relativeProjectPath: restored.relativeProjectPath
    }
    const now = this.find(project.id, task.id)
    if (!now || now.stream.id !== stream.id) {
      // Closed or moved meanwhile: the folder goes again; the branch is the user's work.
      await this.discard(project, workspace, { keepBranch: true })
      this.setState(task.id, null)
      return { status: 'failed', error: 'The task was closed' }
    }
    this.commitTask(project.id, task.id, current => ({ ...current, workspace }))
    this.deps.log?.(`task worktree task=${task.id} restored branch=${workspace.branchName}`)
    const roots = { sourceRoot: base.worktreePath, worktreeRoot: workspace.worktreePath }
    const setup = await this.deps.git.runSetup({ ...roots, branch: workspace.branchName, onOutput: (text) => this.appendLog(task.id, text) })
    return this.afterSetup(task.id, workspace, setup, roots)
  }

  private async runHeld(taskId: string, held: HeldSetup, decision: WorktreeSetupDecision): Promise<TaskWorktreeResult> {
    this.held.delete(taskId)
    if (decision === 'skip') {
      this.setState(taskId, null)
      return { status: 'ready', workspace: held.workspace }
    }
    this.deps.git.approveSetup(held.pending.repoKey, held.pending.hash)
    this.setState(taskId, { phase: 'setup', branch: held.workspace.branchName })
    const setup = await this.deps.git.runSetup({
      sourceRoot: held.sourceRoot,
      worktreeRoot: held.worktreeRoot,
      branch: held.workspace.branchName,
      onOutput: (text) => this.appendLog(taskId, text)
    })
    return this.afterSetup(taskId, held.workspace, setup, held)
  }

  private async afterSetup(
    taskId: string,
    workspace: WorkspaceConfig,
    setup: WorktreeSetupResult,
    roots: { sourceRoot: string; worktreeRoot: string }
  ): Promise<TaskWorktreeResult> {
    if (setup.status !== 'needs-approval') {
      try {
        await this.deps.recordSetupArtifacts?.(roots.worktreeRoot)
      } catch (err) {
        this.deps.log?.(`task worktree setup artifacts task=${taskId} error=${errorMessage(err)}`)
      }
    }
    if (setup.status === 'needs-approval') {
      this.held.set(taskId, { workspace, pending: setup.pending, ...roots })
      this.setState(taskId, { phase: 'needs-approval', branch: workspace.branchName, pending: setup.pending })
      return { status: 'needs-approval', workspace, pending: setup.pending }
    }
    if (setup.status === 'failed') {
      this.setState(taskId, { phase: 'setup-failed', branch: workspace.branchName, error: setup.error })
      return { status: 'ready', workspace, setupError: setup.error }
    }
    this.setState(taskId, null)
    return { status: 'ready', workspace }
  }

  /** What a task that needs nothing more done answers. */
  private current(taskId: string): TaskWorktreeResult {
    for (const project of this.deps.projects.peek().projects) {
      const task = findTaskInProject(project, taskId)
      if (!task) continue
      if (!task.workspace) return { status: 'not-needed' }
      const held = this.held.get(taskId)
      return held
        ? { status: 'needs-approval', workspace: task.workspace, pending: held.pending }
        : { status: 'ready', workspace: task.workspace }
    }
    return { status: 'failed', error: 'No such task' }
  }

  /** `fn` on the task in main's projects, committed. */
  private commitTask(projectId: string, taskId: string, fn: (task: Task) => Task): void {
    const data = this.deps.projects.peek()
    this.deps.projects.commit({
      ...data,
      projects: data.projects.map(p => (p.id === projectId ? mapTaskInProject(p, taskId, fn) : p))
    })
  }

  /** A worktree made for a task that no longer wants it: nothing was done in it yet. */
  private async discard(project: Project, workspace: WorkspaceConfig, options: { keepBranch?: boolean } = {}): Promise<void> {
    try {
      await this.deps.git.delete({
        projectDir: project.directory,
        worktreePath: workspace.worktreePath,
        branchName: workspace.branchName,
        baseBranch: workspace.baseBranch,
        force: true,
        keepBranch: options.keepBranch
      })
    } catch (err) {
      this.deps.log?.(`task worktree discard ${workspace.worktreePath} error=${errorMessage(err)}`)
    }
  }

  private find(projectId: string, taskId: string): Located | null {
    const project = this.deps.projects.peek().projects.find(p => p.id === projectId)
    const stream = findStreamOfTask(project, taskId)
    const task = findTaskInProject(project, taskId)
    return project && stream && task ? { project, stream, task } : null
  }

  /**
   * `probe()` once main's projects have it: a window's save can trail the
   * request it sent right after the change. After the wait, `fallback()`.
   */
  private waitFor<T>(probe: () => T | null, fallback: () => T | null = probe): Promise<T | null> {
    const now = probe()
    if (now) return Promise.resolve(now)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        unsubscribe()
        resolve(fallback())
      }, this.deps.waitMs ?? WAIT_FOR_SAVE_MS)
      const unsubscribe = this.deps.projects.subscribe(() => {
        const found = probe()
        if (!found) return
        clearTimeout(timer)
        unsubscribe()
        resolve(found)
      })
    })
  }

  private setState(taskId: string, state: TaskWorktreeState | null): void {
    const timer = this.publishTimers.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.publishTimers.delete(taskId)
    }
    if (state) this.states.set(taskId, state)
    else if (this.states.has(taskId)) this.states.delete(taskId)
    else return
    this.deps.onState?.(taskId, state)
  }

  private appendLog(taskId: string, text: string): void {
    const state = this.states.get(taskId)
    if (!state || (state.phase !== 'creating' && state.phase !== 'setup')) return
    this.states.set(taskId, { ...state, log: ((state.log ?? '') + text).slice(-LOG_TAIL_CHARS) })
    if (this.publishTimers.has(taskId)) return
    this.publishTimers.set(taskId, setTimeout(() => {
      this.publishTimers.delete(taskId)
      const latest = this.states.get(taskId)
      if (latest) this.deps.onState?.(taskId, latest)
    }, LOG_PUBLISH_MS))
  }
}

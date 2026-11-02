import type { AgentActivity } from '../shared/agent-activity'
import { autopilotActive, autopilotSupported, autopilotTab, stoppedAutopilot } from '../shared/autopilot'

export { autopilotTab }
import { mapTaskInProject, needsTaskWorktree, streamTakesLandings, taskDirectory, taskWorktreesSupported } from '../shared/streams'
import type { Project, ProjectsData, Stream, Tab, TabStatusValue, Task, TaskAutopilot, TaskLandingIntent, TaskLandingResult } from '../shared/types'
import { codexFindingsPrompt, codexReviewPrompt, type CodexReview } from './codex-review'
import type { GitRunner } from './git-runner'
import type { TaskLandingManager } from './task-landing'

/**
 * Autopilot (desk redesign decision 7): a task fired with the chip goes from
 * its first turn to the Done tab with nobody looking. Claude works in auto
 * mode; when its turn ends the task needs files changed, then (with "+ Codex
 * review") one headless Codex review whose findings go back to Claude once,
 * and a second review after that turn; then it lands as ✓ Done does, a
 * conflict going to the agent first (`TaskLandingManager.fixWithAgent`).
 *
 * Anything that wants a person hands the task back (`phase: 'stopped'`, which
 * the inbox shows as Needs you): a question or a permission, a turn that
 * failed, the agent gone, you pressing Stop, no files changed, Codex still
 * unhappy after the fix round, Codex failing, a landing that won't go through.
 * A stopped run is never picked up again: you take it from there.
 *
 * A turn is over when the tab leaves `working`, which waits for what the turn
 * left running: background agents and shells, and hooks still going after its
 * Stop. One of those is an `asyncRewake` review (the security-guidance plugin)
 * that can wake Claude with findings to fix; Autopilot acts after that turn.
 *
 * Main is the one place this can live: it outlasts the windows, and every
 * window sees the same projects (a window-side runner would act once per window).
 * State is on `Task.autopilot`, so the inbox shows where a run is; a restart
 * ends the agent's turn, so a run still going at startup is handed back.
 */

/** How long a finished turn must stay finished before Autopilot acts (a resumed turn, a Done clicked meanwhile). */
const SETTLE_MS = 1500
/** A review whose findings go back to Claude, then the one after Claude's fix. */
const MAX_REVIEWS = 2
/** DevTool's hooks file is never the task's work. */
const HOOK_FILE = '.claude/settings.local.json'
const REASON_MAX = 240

export interface AutopilotDeps {
  peek(): ProjectsData
  commit(next: ProjectsData): void
  subscribeProjects(listener: () => void): () => void
  /** Main's tab statuses and activity (`TabActivityRegistry`), and their change feed. */
  statusOf(tabId: string): TabStatusValue
  activityOf(tabId: string): AgentActivity | null
  subscribe(listener: (tabId: string) => void): () => void
  runner: GitRunner
  /** One headless Codex review in `cwd` (`runCodexReview`). */
  review(cwd: string, prompt: string): Promise<CodexReview>
  /** Types `text` into the agent tab and submits it. Throws when it can't. */
  sendToAgent(project: Project, task: Task, tab: Tab, text: string): Promise<void>
  landing: Pick<TaskLandingManager, 'landTask' | 'fixWithAgent' | 'isBusy'>
  /** Ends a task's tabs and archives it: Done for a task with no worktree of its own. */
  archiveTask(project: Project, task: Task): Promise<void>
  log(message: string): void
  now?(): number
  settleMs?: number
}

interface Found {
  project: Project
  stream: Stream
  task: Task
  autopilot: TaskAutopilot
  tab: Tab
}

/** What the task changed, measured from `base`, in `root` (the git checkout it works in). */
export interface AutopilotDiff {
  root: string
  base: string
  /** Where the work goes, in words for Codex. */
  target: string
  files: number
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line
}

/** Why a turn that ended waiting on you stops the run. */
export function attentionReason(activity: AgentActivity | null): string {
  const waiting = activity?.waiting
  if (waiting?.kind === 'error') return `The turn failed: ${waiting.label}`
  if (waiting?.kind === 'permission') return `Wants a permission: ${waiting.label.replace(/^Permission:\s*/, '')}`
  return 'Claude asked you something'
}

/** A landing's result as the reason a run stops, or null when it went through (or goes on). */
export function landingStopReason(result: TaskLandingResult, streamName: string): string | null {
  switch (result.status) {
    case 'landed':
    case 'nothing':
    case 'removed':
    case 'fixing':
      return null
    case 'conflict':
      return `Conflicts with ${streamName} the agent couldn't resolve`
    case 'blocked':
      return `${streamName} has local changes in the way`
    case 'working':
      return 'The agent was still working'
    case 'failed':
      return `Couldn't land: ${result.error}`
    default:
      return `Couldn't land (${result.status})`
  }
}

export class AutopilotRunner {
  private readonly lastStatus = new Map<string, TabStatusValue>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Tasks Autopilot is acting on right now (a review, a landing call). */
  private readonly acting = new Set<string>()
  /** Tasks whose `base` is being read. */
  private readonly basing = new Set<string>()
  private unsubscribe: (() => void)[] = []

  constructor(private readonly deps: AutopilotDeps) {}

  start(): void {
    if (this.unsubscribe.length > 0) return
    // The agent's turn didn't survive the restart, nor did a review or the
    // agent fixing a conflict (the landing's own reconcile makes that a conflict).
    this.forEachRun(found => this.stop(found.task.id, 'DevTool restarted before Autopilot finished'))
    this.unsubscribe = [
      this.deps.subscribe(tabId => this.tabChanged(tabId)),
      this.deps.subscribeProjects(() => this.projectsChanged())
    ]
    this.projectsChanged()
  }

  dispose(): void {
    for (const stop of this.unsubscribe) stop()
    this.unsubscribe = []
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** You pressed Stop in the task's chat: the run is yours now. */
  interrupted(tabId: string): void {
    const found = this.findByTab(tabId)
    if (!found || (found.autopilot.phase !== 'working' && found.autopilot.phase !== 'fixing')) return
    this.stop(found.task.id, 'You stopped it')
  }

  /**
   * A landing that went to the agent over a conflict resumed by itself
   * (`TaskLandingDeps.onResumed`). Landed, the task is archived already.
   */
  landingResumed(_projectId: string, taskId: string, _intent: TaskLandingIntent, result: TaskLandingResult): void {
    const found = this.find(taskId)
    if (!found || found.autopilot.phase !== 'landing') return
    const reason = landingStopReason(result, found.stream.name)
    if (reason) this.stop(taskId, reason)
  }

  // ---- watching ----------------------------------------------------------------------

  private tabChanged(tabId: string): void {
    const previous = this.lastStatus.get(tabId) ?? null
    const status = this.deps.statusOf(tabId)
    this.lastStatus.set(tabId, status)
    if (previous === status) return
    const found = this.findByTab(tabId)
    if (!found) return
    if (status === 'attention') {
      this.stop(found.task.id, attentionReason(this.deps.activityOf(tabId)))
      return
    }
    if (status === 'exited') {
      this.stop(found.task.id, 'The agent exited')
      return
    }
    if (status === 'working') {
      this.clearTimer(found.task.id)
      return
    }
    if (previous === 'working' && status === null && (found.autopilot.phase === 'working' || found.autopilot.phase === 'fixing')) {
      this.clearTimer(found.task.id)
      const taskId = found.task.id
      this.timers.set(taskId, setTimeout(() => {
        this.timers.delete(taskId)
        void this.turnEnded(taskId, tabId)
      }, this.deps.settleMs ?? SETTLE_MS))
    }
  }

  /** A task with no worktree of its own diffs against where its folder was when the run began. */
  private projectsChanged(): void {
    this.forEachRun(found => {
      const { project, stream, task, autopilot } = found
      if (autopilot.phase !== 'working' || autopilot.base || task.workspace || this.basing.has(task.id)) return
      if (needsTaskWorktree(project, stream, task)) return
      this.basing.add(task.id)
      void this.deps.runner.run(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: taskDirectory(project, task) })
        .then(result => {
          const base = result.code === 0 ? result.stdout.trim() : ''
          if (base) this.update(task.id, current => (current.base ? current : { ...current, base }))
        })
        .finally(() => this.basing.delete(task.id))
    })
  }

  // ---- moving the run on --------------------------------------------------------------

  private async turnEnded(taskId: string, tabId: string): Promise<void> {
    const found = this.find(taskId)
    if (!found || found.tab.id !== tabId) return
    const { phase } = found.autopilot
    if (phase !== 'working' && phase !== 'fixing') return
    // A turn that resumed meanwhile, or a landing someone else started (✓ Done).
    if (this.deps.statusOf(tabId) !== null || found.task.landing || this.deps.landing.isBusy(taskId) || this.acting.has(taskId)) return
    this.acting.add(taskId)
    try {
      await this.advance(found)
    } catch (err) {
      this.stop(taskId, `Autopilot failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.acting.delete(taskId)
    }
  }

  private async advance(found: Found): Promise<void> {
    const { project, task, autopilot, tab } = found
    const diff = await this.diffOf(found)
    if (!diff) {
      this.stop(task.id, 'Couldn\'t read what the task changed')
      return
    }
    if (diff.files === 0) {
      this.stop(task.id, 'No files changed')
      return
    }
    const summary = this.deps.activityOf(tab.id)?.lastAnswer
    const reviews = autopilot.reviews ?? 0
    if (autopilot.review && reviews < MAX_REVIEWS) {
      this.update(task.id, current => ({ ...current, phase: 'reviewing' }))
      this.deps.log(`autopilot task=${task.id} codex review ${reviews + 1}`)
      const review = await this.deps.review(diff.root, codexReviewPrompt({ base: diff.base, target: diff.target, taskName: task.name, summary }))
      // Handed back, or Done, while Codex read.
      const current = this.find(task.id)
      if (!current || current.autopilot.phase !== 'reviewing') return
      this.update(task.id, ap => ({ ...ap, reviews: reviews + 1 }))
      if (review.status === 'failed') {
        this.stop(task.id, `Codex couldn't review: ${review.error}`)
        return
      }
      if (review.status === 'findings') {
        if (reviews + 1 >= MAX_REVIEWS) {
          this.stop(task.id, `Codex still has findings: ${review.text}`)
          return
        }
        this.update(task.id, ap => ({ ...ap, phase: 'fixing' }))
        try {
          await this.deps.sendToAgent(current.project, current.task, current.tab, codexFindingsPrompt(review.text))
        } catch (err) {
          this.stop(task.id, `Couldn't send Codex's findings to Claude: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
    }
    await this.land(task.id, project.id, summary)
  }

  /** Lands as ✓ Done does; a task with no worktree of its own just closes. */
  private async land(taskId: string, projectId: string, summary: string | undefined): Promise<void> {
    const found = this.find(taskId)
    if (!found) return
    this.update(taskId, current => ({ ...current, phase: 'landing' }))
    const { project, stream, task } = found
    this.deps.log(`autopilot task=${taskId} landing`)
    if (!(taskWorktreesSupported(project) && task.workspace && streamTakesLandings(stream))) {
      const latest = this.find(taskId)
      if (latest) await this.deps.archiveTask(latest.project, latest.task)
      return
    }
    let result = await this.deps.landing.landTask(projectId, taskId, { summary })
    if (result.status === 'conflict') result = await this.deps.landing.fixWithAgent(projectId, taskId)
    const reason = landingStopReason(result, stream.name)
    if (reason) this.stop(taskId, reason)
  }

  /**
   * What the task changed: in its own worktree, everything since it left the
   * stream (committed or not); else what changed in its folder since the run
   * began. Untracked files count. Null when git can't tell (not a repository).
   */
  private async diffOf({ project, stream, task, autopilot }: Found): Promise<AutopilotDiff | null> {
    const run = (root: string, args: string[]): Promise<string | null> =>
      this.deps.runner.run(args, { cwd: root }).then(result => (result.code === 0 ? result.stdout : null))
    let root: string
    let base: string | null
    let target: string
    if (task.workspace && streamTakesLandings(stream)) {
      root = task.workspace.worktreePath
      // The stream's branch; main's is the one the task left.
      const branch = stream.workspace?.branchName ?? task.workspace.baseBranch
      base = (await run(root, ['merge-base', `refs/heads/${branch}`, 'HEAD']))?.trim() ?? null
      target = `the ${stream.workspace ? 'stream ' : ''}branch \`${branch}\``
    } else {
      root = taskDirectory(project, task)
      base = autopilot.base ?? (await run(root, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() ?? null
      const branch = (await run(root, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim()
      target = branch ? `the branch \`${branch}\`` : 'this checkout'
    }
    if (!base) return null
    const changed = await run(root, ['diff', '--name-only', '-z', base])
    const untracked = await run(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    if (changed === null || untracked === null) return null
    const files = new Set([...changed.split('\0'), ...untracked.split('\0')]
      .filter(file => file && file !== HOOK_FILE && !file.endsWith(`/${HOOK_FILE}`)))
    return { root, base, target, files: files.size }
  }

  // ---- data ---------------------------------------------------------------------------

  private stop(taskId: string, reason: string): void {
    this.clearTimer(taskId)
    const now = this.deps.now?.() ?? Date.now()
    if (this.update(taskId, current => (current.phase === 'stopped' ? current : stoppedAutopilot(current, oneLine(reason), now)))) {
      this.deps.log(`autopilot task=${taskId} stopped reason=${JSON.stringify(oneLine(reason))}`)
    }
  }

  /** `fn` on the task's running Autopilot, committed when it changed anything. */
  private update(taskId: string, fn: (autopilot: TaskAutopilot) => TaskAutopilot): boolean {
    const data = this.deps.peek()
    let changed = false
    const projects = data.projects.map(project => {
      const found = this.inProject(project, taskId)
      if (!found) return project
      const next = fn(found.autopilot)
      if (next === found.autopilot) return project
      changed = true
      return mapTaskInProject(project, taskId, task => ({ ...task, autopilot: next }))
    })
    if (changed) this.deps.commit({ ...data, projects })
    return changed
  }

  private clearTimer(taskId: string): void {
    const timer = this.timers.get(taskId)
    if (timer) clearTimeout(timer)
    this.timers.delete(taskId)
  }

  private inProject(project: Project, taskId: string): Found | null {
    if (!autopilotSupported(project)) return null
    for (const stream of project.streams) {
      const task = stream.tasks.find(candidate => candidate.id === taskId)
      if (!task) continue
      const tab = autopilotTab(task)
      if (!task.autopilot || !autopilotActive(task) || !tab) return null
      return { project, stream, task, autopilot: task.autopilot, tab }
    }
    return null
  }

  private find(taskId: string): Found | null {
    for (const project of this.deps.peek().projects) {
      const found = this.inProject(project, taskId)
      if (found) return found
    }
    return null
  }

  private findByTab(tabId: string): Found | null {
    let hit: Found | null = null
    this.forEachRun(found => {
      if (!hit && found.tab.id === tabId) hit = found
    })
    return hit
  }

  private forEachRun(fn: (found: Found) => void): void {
    for (const project of this.deps.peek().projects) {
      if (!autopilotSupported(project)) continue
      for (const stream of project.streams) {
        for (const task of stream.tasks) {
          if (!autopilotActive(task)) continue
          const found = this.inProject(project, task.id)
          if (found) fn(found)
        }
      }
    }
  }
}

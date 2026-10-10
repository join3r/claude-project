import type { Project, ProjectsData, TabStatusValue } from '../shared/types'
import {
  nextAutoRunPrompt,
  queuedPromptStream,
  restoreQueuedPrompt,
  setPromptQueueWatch,
  stopPromptQueueAutoRun,
  takeQueuedPrompt,
  type PromptQueueRunResult
} from '../shared/prompt-queue'
import { addChatTaskToProject } from './mobile/new-task'

export interface PromptQueueRunnerDeps {
  peek(): ProjectsData
  commit(data: ProjectsData): void
  /** Called after every change to the projects, whoever made it. */
  subscribeProjects(listener: () => void): () => void
  /** Main's status for a tab (`TabActivityRegistry`), and its change feed. */
  statusOf(tabId: string): TabStatusValue
  subscribe(listener: (tabId: string) => void): () => void
  /** Why a project's queue can't start a Claude chat now, or null when it can. */
  blocker(project: Project): string | null
  /** Makes the task's own worktree when its stream gives tasks one. */
  ensureWorktree(projectId: string, taskId: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Starts the chat tab's runtime and sends it the first prompt. */
  sendFirstPrompt(projectId: string, taskId: string, tabId: string, prompt: string): Promise<void>
  /** Gives the new task a short title in the background (`task-namer.ts`). */
  nameTask(projectId: string, taskId: string, prompt: string): void
  log(message: string): void
}

function mapProject(data: ProjectsData, projectId: string, update: (project: Project) => Project): ProjectsData {
  return { ...data, projects: data.projects.map(p => (p.id === projectId ? update(p) : p)) }
}

/**
 * Runs Project Home's queued prompts. Run takes one off the queue and starts it
 * as a new Claude chat task in its stream — the way a phone's New task does, so
 * no window has to be open and none switches to it — and the stream remembers
 * that task (`promptQueueWatch`).
 *
 * Each stream is its own queue: with its auto-run on, it starts its next prompt
 * whenever nothing it started is still running — the watched task went from
 * working to idle, was put away with Done for now, or was closed. Needing you
 * (`attention`) is not finished, and an agent that died (`exited`) switches the
 * stream's auto-run off, as does a start that fails. Streams don't wait on each
 * other: each works on its own branch.
 *
 * Main is the one place this can live: every window sees the same projects, so a
 * window-side runner would start the next prompt once per window.
 */
export class PromptQueueRunner {
  private readonly lastStatus = new Map<string, TabStatusValue>()
  /** Streams with a run in flight (`projectId/streamId`): a second click, or a finish meanwhile, waits its turn. */
  private readonly running = new Set<string>()
  private unsubscribe: (() => void)[] = []
  private advanceQueued = false

  constructor(private readonly deps: PromptQueueRunnerDeps) {}

  start(): void {
    if (this.unsubscribe.length > 0) return
    this.unsubscribe = [
      this.deps.subscribe(tabId => this.tabChanged(tabId)),
      this.deps.subscribeProjects(() => this.scheduleAdvance())
    ]
    this.scheduleAdvance()
  }

  dispose(): void {
    for (const stop of this.unsubscribe) stop()
    this.unsubscribe = []
  }

  async run(projectId: string, itemId: string): Promise<PromptQueueRunResult> {
    const data = this.deps.peek()
    const project = data.projects.find(p => p.id === projectId)
    if (!project) return { ok: false, error: 'No such project.' }
    const blocked = this.deps.blocker(project)
    if (blocked) return { ok: false, error: blocked }
    const taken = takeQueuedPrompt(project, itemId)
    if (!taken) return { ok: false, error: 'That prompt is no longer queued.' }
    const streamId = queuedPromptStream(taken.project, taken.item)?.id
    if (!streamId) return { ok: false, error: 'The project has no stream to run it in.' }
    const key = `${projectId}/${streamId}`
    if (this.running.has(key)) return { ok: false, error: 'A queued prompt is already starting.' }

    this.running.add(key)
    try {
      const withoutItem = mapProject(data, projectId, () => taken.project)
      const added = addChatTaskToProject(withoutItem, taken.project, taken.item.text, streamId)
      this.deps.commit(mapProject(added.data, projectId, p => setPromptQueueWatch(p, streamId, { taskId: added.taskId, tabId: added.tabId })))

      const worktree = await this.deps.ensureWorktree(projectId, added.taskId)
      if (!worktree.ok) {
        // Nothing ran in it yet: the task goes and the prompt is back where it was.
        this.deps.commit(mapProject(this.deps.peek(), projectId, p => {
          const without = { ...p, streams: p.streams.map(s => ({ ...s, tasks: s.tasks.filter(t => t.id !== added.taskId) })) }
          return setPromptQueueWatch(restoreQueuedPrompt(without, taken.item, taken.index), streamId, null)
        }))
        return { ok: false, error: `Couldn't create the task's worktree: ${worktree.error}` }
      }
      this.deps.nameTask(projectId, added.taskId, taken.item.text)
      // The task exists from here on, so a failed start is logged, not undone:
      // the chat shows its own state, and running it again would make a second task.
      try {
        await this.deps.sendFirstPrompt(projectId, added.taskId, added.tabId, taken.item.text)
      } catch (err) {
        this.deps.log(`prompt-queue start tab=${added.tabId} error=${err instanceof Error ? err.message : String(err)}`)
      }
      return { ok: true, taskId: added.taskId }
    } finally {
      this.running.delete(key)
    }
  }

  /** Coalesces a burst of project changes into one look at every auto-run stream. */
  private scheduleAdvance(): void {
    if (this.advanceQueued) return
    this.advanceQueued = true
    queueMicrotask(() => {
      this.advanceQueued = false
      this.advance()
    })
  }

  /** Starts the next prompt of every auto-run stream that has nothing running. */
  private advance(): void {
    for (const project of this.deps.peek().projects) {
      // A server's projects are run by the server's own runner.
      if (project.host || !project.promptQueue?.length) continue
      for (const stream of project.streams) {
        if (this.running.has(`${project.id}/${stream.id}`)) continue
        const next = nextAutoRunPrompt(project, stream)
        if (!next) continue
        // Waiting is fine (Claude off, say): the switch stays on and the queue
        // starts with the next change to the projects.
        if (this.deps.blocker(project)) break
        void this.run(project.id, next.id).then(result => {
          if (result.ok) return
          // Off, or every later change would retry it.
          this.deps.log(`prompt-queue auto-run project=${project.id} stream=${stream.id} error=${result.error}`)
          this.deps.commit(mapProject(this.deps.peek(), project.id, p => stopPromptQueueAutoRun(p, stream.id)))
        })
      }
    }
  }

  private tabChanged(tabId: string): void {
    const previous = this.lastStatus.get(tabId) ?? null
    const status = this.deps.statusOf(tabId)
    this.lastStatus.set(tabId, status)
    const finished = previous === 'working' && status === null
    if (!finished && status !== 'exited') return

    for (const project of this.deps.peek().projects) {
      const stream = project.streams.find(s => s.promptQueueWatch?.tabId === tabId)
      if (!stream) continue
      this.lastStatus.delete(tabId)
      // Clearing the watch lets `advance` start the next prompt on an auto-run stream.
      this.deps.commit(mapProject(this.deps.peek(), project.id, p => {
        const cleared = setPromptQueueWatch(p, stream.id, null)
        return finished ? cleared : stopPromptQueueAutoRun(cleared, stream.id)
      }))
      return
    }
  }
}

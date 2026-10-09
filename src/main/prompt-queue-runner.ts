import type { Project, ProjectsData, TabStatusValue } from '../shared/types'
import { promptQueue, queuedPromptStream, restoreQueuedPrompt, setPromptQueueWatch, takeQueuedPrompt, type PromptQueueRunResult } from '../shared/prompt-queue'
import { addChatTaskToProject } from './mobile/new-task'

export interface PromptQueueRunnerDeps {
  peek(): ProjectsData
  commit(data: ProjectsData): void
  /** Main's status for a tab (`TabActivityRegistry`), and its change feed. */
  statusOf(tabId: string): TabStatusValue
  subscribe(listener: (tabId: string) => void): () => void
  /** Why a project's queue can't start a Claude chat now, or null when it can. */
  blocker(project: Project): string | null
  /** Makes the task's own worktree when its stream gives tasks one. */
  ensureWorktree(projectId: string, taskId: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Starts the chat tab's runtime and sends it the first prompt. */
  sendFirstPrompt(projectId: string, taskId: string, tabId: string, prompt: string): Promise<void>
  log(message: string): void
}

function mapProject(data: ProjectsData, projectId: string, update: (project: Project) => Project): ProjectsData {
  return { ...data, projects: data.projects.map(p => (p.id === projectId ? update(p) : p)) }
}

/**
 * Runs Project Home's queued prompts. Run takes one off the queue and starts it
 * as a new Claude chat task in its stream — the way a phone's New task does, so
 * no window has to be open and none switches to it — and remembers that task
 * (`promptQueueWatch`). With auto-run on, the watched task going from working to
 * idle starts the next prompt. Needing you (`attention`) is not finished, and an
 * agent that died (`exited`) ends the chain.
 *
 * Main is the one place this can live: every window sees the same projects, so a
 * window-side runner would start the next prompt once per window.
 */
export class PromptQueueRunner {
  private readonly lastStatus = new Map<string, TabStatusValue>()
  /** Projects with a run in flight: a second click, or a finish meanwhile, waits its turn. */
  private readonly running = new Set<string>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: PromptQueueRunnerDeps) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.deps.subscribe(tabId => this.tabChanged(tabId))
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  async run(projectId: string, itemId: string): Promise<PromptQueueRunResult> {
    if (this.running.has(projectId)) return { ok: false, error: 'A queued prompt is already starting.' }
    const data = this.deps.peek()
    const project = data.projects.find(p => p.id === projectId)
    if (!project) return { ok: false, error: 'No such project.' }
    const blocked = this.deps.blocker(project)
    if (blocked) return { ok: false, error: blocked }
    const taken = takeQueuedPrompt(project, itemId)
    if (!taken) return { ok: false, error: 'That prompt is no longer queued.' }

    this.running.add(projectId)
    try {
      const streamId = queuedPromptStream(taken.project, taken.item)?.id
      const withoutItem = mapProject(data, projectId, () => taken.project)
      const added = addChatTaskToProject(withoutItem, taken.project, taken.item.text, streamId)
      this.deps.commit(mapProject(added.data, projectId, p => setPromptQueueWatch(p, { taskId: added.taskId, tabId: added.tabId })))

      const worktree = await this.deps.ensureWorktree(projectId, added.taskId)
      if (!worktree.ok) {
        // Nothing ran in it yet: the task goes and the prompt is back where it was.
        this.deps.commit(mapProject(this.deps.peek(), projectId, p => {
          const without = { ...p, streams: p.streams.map(s => ({ ...s, tasks: s.tasks.filter(t => t.id !== added.taskId) })) }
          return setPromptQueueWatch(restoreQueuedPrompt(without, taken.item, taken.index), null)
        }))
        return { ok: false, error: `Couldn't create the task's worktree: ${worktree.error}` }
      }
      // The task exists from here on, so a failed start is logged, not undone:
      // the chat shows its own state, and running it again would make a second task.
      try {
        await this.deps.sendFirstPrompt(projectId, added.taskId, added.tabId, taken.item.text)
      } catch (err) {
        this.deps.log(`prompt-queue start tab=${added.tabId} error=${err instanceof Error ? err.message : String(err)}`)
      }
      return { ok: true, taskId: added.taskId }
    } finally {
      this.running.delete(projectId)
    }
  }

  private tabChanged(tabId: string): void {
    const previous = this.lastStatus.get(tabId) ?? null
    const status = this.deps.statusOf(tabId)
    this.lastStatus.set(tabId, status)
    const finished = previous === 'working' && status === null
    if (!finished && status !== 'exited') return

    const project = this.deps.peek().projects.find(p => p.promptQueueWatch?.tabId === tabId)
    if (!project) return
    this.lastStatus.delete(tabId)
    const next = finished && project.promptQueueAutoRun ? promptQueue(project)[0] : undefined
    if (!next) {
      this.clearWatch(project.id, tabId)
      return
    }
    void this.run(project.id, next.id).then(result => {
      if (result.ok) return
      this.deps.log(`prompt-queue auto-run project=${project.id} error=${result.error}`)
      this.clearWatch(project.id, tabId)
    })
  }

  private clearWatch(projectId: string, tabId: string): void {
    const project = this.deps.peek().projects.find(p => p.id === projectId)
    if (project?.promptQueueWatch?.tabId !== tabId) return
    this.deps.commit(mapProject(this.deps.peek(), projectId, p => setPromptQueueWatch(p, null)))
  }
}

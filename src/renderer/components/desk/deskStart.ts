import type { AppConfig, DeskScope, Project, PromptBoxAgent, Stream, Task } from '../../../shared/types'
import type { ChatImage } from '../../../shared/claude-chat'
import { findMainStream, streamDirectory, streamGivesTaskWorktrees, taskDirectory, taskWorktreesSupported } from '../../../shared/streams'
import { isTaskWorking, type StatusOf } from '../sidebar/closeRules'
import { availablePromptAgents, pickPromptAgent } from '../promptBox'
import type { NewTaskSubmission } from '../newTask'
import { autopilotSupported } from '../../../shared/autopilot'
import { fuzzyMatch } from '../../palette/fuzzy'

/** The Autopilot chip: off by default every time (decision 7), "+ Codex review" inside it. */
export interface DeskAutopilot {
  on: boolean
  review: boolean
}

export const AUTOPILOT_OFF: DeskAutopilot = { on: false, review: false }

/** Whether the chip can be offered for this start. */
export function autopilotAvailable(project: Project | undefined, agent: PromptBoxAgent | null): boolean {
  return !!project && agent === 'claude-chat' && autopilotSupported(project)
}

/**
 * Starting a task from the desk (its compose box and the ⌘K bar): which agent,
 * what gets filed, and the project and stream you last fired into (the default
 * aim when the column shows All, or the project without a stream).
 */
const LAST_PROJECT_KEY = 'devtool.desk.lastProjectId'
const LAST_STREAM_KEY = 'devtool.desk.lastStreamId'

export function readLastWhere(): DeskScope | null {
  try {
    const projectId = window.localStorage.getItem(LAST_PROJECT_KEY)
    if (!projectId) return null
    const streamId = window.localStorage.getItem(LAST_STREAM_KEY)
    return streamId ? { projectId, streamId } : { projectId }
  } catch { return null }
}

export function writeLastWhere(project: Project, stream: Stream | undefined): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, project.id)
    if (stream && !stream.isMain) window.localStorage.setItem(LAST_STREAM_KEY, stream.id)
    else window.localStorage.removeItem(LAST_STREAM_KEY)
  } catch { /* storage blocked: the default just falls back */ }
}

/**
 * The agents a project offers and the one a task starts with: a chip's pick,
 * else Settings' quick-task agent (Claude chat unless changed), else the saved one.
 * `isDefault`: it is the Settings one, so the compose box needn't name it.
 */
export function deskAgents(
  config: AppConfig,
  project: Project | undefined,
  override: PromptBoxAgent | null
): { agents: PromptBoxAgent[]; agent: PromptBoxAgent | null; isDefault: boolean } {
  const agents = project ? availablePromptAgents(config, project) : []
  const preferred = config.deskAgent ?? 'claude-chat'
  const agent = (override && agents.includes(override) ? override : null)
    ?? (agents.includes(preferred) ? preferred : pickPromptAgent(config.promptBoxAgent, agents))
  return { agents, agent, isDefault: agent === preferred }
}

/**
 * A task on `prompt` in `project` (and `stream`), in auto mode (decision 2 of
 * the redesign); no agent → a terminal running it. `autopilot` and `images`
 * hold only for a Claude chat (Autopilot also needs a project it can run in).
 */
export function deskSubmission(
  project: Project,
  stream: Stream | undefined,
  agent: PromptBoxAgent | null,
  prompt: string,
  autopilot?: DeskAutopilot | null,
  images?: readonly ChatImage[]
): NewTaskSubmission {
  const chat = agent === 'claude-chat'
  return {
    target: { kind: 'project', projectId: project.id },
    ...(stream ? { streamId: stream.id } : {}),
    ...(autopilot?.on && chat && autopilotSupported(project) ? { autopilot: { review: autopilot.review } } : {}),
    ...(agent
      ? { start: { agent, prompt: {
          text: prompt,
          ...(chat || agent === 'claude' ? { mode: 'auto' as const } : {}),
          ...(chat && images?.length ? { images: [...images] } : {})
        } } }
      : { terminal: { command: prompt } })
  }
}

/** Whether a new task in `stream` gets a worktree of its own (a task-worktree stream in a project that has them). */
export function startsInOwnWorktree(project: Project, stream: Stream | undefined): boolean {
  return streamGivesTaskWorktrees(stream) && taskWorktreesSupported(project)
}

/**
 * The tasks whose agent is working in the folder a new task in `stream` (none:
 * `main`) would start in: the project folder, or a stream worktree its tasks
 * share. Empty when the new task gets a worktree of its own. Two agents in one
 * folder edit the same files, so starting there warns.
 */
export function busyInSameFolder(project: Project, stream: Stream | undefined, statusOf: StatusOf): Task[] {
  const target = stream ?? findMainStream(project)
  if (startsInOwnWorktree(project, target)) return []
  const dir = streamDirectory(project, target)
  return project.streams.flatMap(candidate => candidate.tasks)
    .filter(task => isTaskWorking(task, statusOf) && taskDirectory(project, task) === dir)
}

/** The warning's one line: who works where, and what to do about it. */
export function sameFolderWarning(project: Project, stream: Stream | undefined, busy: readonly Task[]): string {
  const target = stream ?? findMainStream(project)
  const where = target?.workspace ? `the ${target.name} worktree` : 'the project folder'
  const who = busy.length === 1 ? `"${busy[0].name}" is` : `${busy.length} agents are`
  return `${who} already working in ${where}. Two agents there edit the same files; a new stream gives this one its own worktree.`
}

/** When you last worked in a stream: its most recently touched task. */
function streamRecency(stream: Stream): number {
  return stream.tasks.reduce((latest, task) => Math.max(latest, task.lastInteractedAt ?? 0), 0)
}

/** When you last worked in a project, across its streams. */
export function projectRecency(project: Project): number {
  return project.streams.reduce((latest, stream) => Math.max(latest, streamRecency(stream)), 0)
}

/**
 * The `@project` being typed at the caret: an `@` at the start or after
 * whitespace, with no whitespace between it and the caret. Null when there is none.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null
  const query = before.slice(at + 1)
  return /\s/.test(query) ? null : { start: at, query }
}

/** A row of the compose box's where picker: a project, or one of its non-main streams. */
export interface WhereOption {
  key: string
  project: Project
  stream?: Stream
}

/**
 * The where picker's rows, most recently worked in first, each project
 * followed by its non-main streams.
 * Typed text narrows them (a stream matches on "project stream"), best first.
 */
export function whereOptions(projects: readonly Project[], filter: string): WhereOption[] {
  const byRecency = <T>(items: readonly T[], at: (item: T) => number): T[] =>
    items.map((item, index) => ({ item, index, at: at(item) }))
      .sort((x, y) => y.at - x.at || x.index - y.index)
      .map(entry => entry.item)
  const all: WhereOption[] = byRecency(projects, projectRecency).flatMap(project => [
    { key: project.id, project },
    ...byRecency(project.streams.filter(stream => !stream.isMain), streamRecency)
      .map(stream => ({ key: `${project.id}:${stream.id}`, project, stream }))
  ])
  const query = filter.trim()
  if (!query) return all
  return all
    .map(option => ({ option, score: fuzzyMatch(query, option.stream ? `${option.project.name} ${option.stream.name}` : option.project.name)?.score ?? -1 }))
    .filter(scored => scored.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(scored => scored.option)
}

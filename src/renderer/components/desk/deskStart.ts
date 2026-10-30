import type { AppConfig, Project, PromptBoxAgent, Stream } from '../../../shared/types'
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
 * what gets filed, and the project you last fired into (the default aim when
 * the column shows All).
 */
const LAST_PROJECT_KEY = 'devtool.desk.lastProjectId'

export function readLastProject(): string | null {
  try { return window.localStorage.getItem(LAST_PROJECT_KEY) } catch { return null }
}

export function writeLastProject(id: string): void {
  try { window.localStorage.setItem(LAST_PROJECT_KEY, id) } catch { /* storage blocked: the default just falls back */ }
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
 * the redesign); no agent → a terminal running it. `autopilot` holds only for a
 * Claude chat in a project Autopilot can run in.
 */
export function deskSubmission(
  project: Project,
  stream: Stream | undefined,
  agent: PromptBoxAgent | null,
  prompt: string,
  autopilot?: DeskAutopilot | null
): NewTaskSubmission {
  return {
    target: { kind: 'project', projectId: project.id },
    ...(stream ? { streamId: stream.id } : {}),
    ...(autopilot?.on && agent === 'claude-chat' && autopilotSupported(project) ? { autopilot: { review: autopilot.review } } : {}),
    ...(agent
      ? { start: { agent, prompt: { text: prompt, ...(agent === 'claude-chat' || agent === 'claude' ? { mode: 'auto' as const } : {}) } } }
      : { terminal: { command: prompt } })
  }
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

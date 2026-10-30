import type { AppConfig, Project, PromptBoxAgent, Stream } from '../../../shared/types'
import { availablePromptAgents, pickPromptAgent } from '../promptBox'
import type { NewTaskSubmission } from '../newTask'
import { autopilotSupported } from '../../../shared/autopilot'

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

/** The agents a project offers and the one a task starts with: a chip's pick, else Claude chat (the desk's agent), else the saved one. */
export function deskAgents(
  config: AppConfig,
  project: Project | undefined,
  override: PromptBoxAgent | null
): { agents: PromptBoxAgent[]; agent: PromptBoxAgent | null } {
  const agents = project ? availablePromptAgents(config, project) : []
  const agent = (override && agents.includes(override) ? override : null)
    ?? (agents.includes('claude-chat') ? 'claude-chat' : pickPromptAgent(config.promptBoxAgent, agents))
  return { agents, agent }
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

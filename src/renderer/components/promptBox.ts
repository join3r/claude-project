/**
 * The empty task's prompt box: pick an agent, type the first prompt, send. These
 * are the parts with rules in them, kept apart from the component so they can be
 * tested without a renderer.
 */

import { NEW_TASK_NAME, PROMPT_BOX_AGENTS } from '../../shared/types'
import type { AiTabType, AppConfig, Project, PromptBoxAgent } from '../../shared/types'

export const PROMPT_BOX_AGENT_LABEL: Record<PromptBoxAgent, string> = {
  'claude-chat': 'Claude',
  claude: 'Claude (terminal)',
  codex: 'Codex',
  pi: 'Pi'
}

/** What the first spawn or first send of an agent tab carries. */
export interface PendingPrompt {
  text: string
  /** Claude only: a permission mode; '' or undefined leaves Claude's own default. */
  mode?: string
  /** Claude chat only. */
  model?: string
  /** Claude chat only. */
  effort?: string
}

const TASK_NAME_MAX = 50

/** A task name from the prompt's first non-empty line, whitespace collapsed, cut to fit the sidebar. */
export function taskNameFromPrompt(text: string, max = TASK_NAME_MAX): string {
  const line = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => l.length > 0) ?? ''
  if (line.length <= max) return line
  return line.slice(0, max - 1).trimEnd() + '…'
}

/** Only a task still carrying the placeholder name is renamed; a name someone typed stays. */
export function shouldNameTask(currentName: string): boolean {
  const name = currentName.trim()
  return name === '' || name === NEW_TASK_NAME
}

/**
 * The agents this project's prompt box offers: the ones switched on in Settings, in
 * a fixed order. A shell-command project runs one command, not agents, so it gets none.
 */
export function availablePromptAgents(
  config: Pick<AppConfig, 'enableClaude' | 'enableCodex' | 'enablePi'>,
  project: Pick<Project, 'shellCommand'>
): PromptBoxAgent[] {
  if (project.shellCommand) return []
  return PROMPT_BOX_AGENTS.filter((agent) => {
    if (agent === 'claude-chat' || agent === 'claude') return config.enableClaude
    if (agent === 'codex') return config.enableCodex
    return config.enablePi
  })
}

/** The remembered agent when it is still on offer, otherwise the first one that is. */
export function pickPromptAgent(saved: PromptBoxAgent | undefined, available: readonly PromptBoxAgent[]): PromptBoxAgent | null {
  if (saved && available.includes(saved)) return saved
  return available[0] ?? null
}

/** Claude takes a permission mode in both views; Codex and Pi keep their own config. */
export function agentTakesMode(agent: PromptBoxAgent): boolean {
  return agent === 'claude-chat' || agent === 'claude'
}

const PERMISSION_FLAGS = ['--permission-mode', '--dangerously-skip-permissions']

/**
 * Arguments appended to a terminal agent's first spawn so it starts on the prompt.
 * A permission mode is passed only when the project's own args don't already set
 * one. The prompt is one argv element; a leading dash would read as a flag, so it
 * gets a leading space instead. `withPrompt` is false where the prompt can't go
 * through argv safely (Windows `.cmd` shims run under cmd.exe) and is pasted
 * into the TUI instead.
 */
export function initialPromptArgs(
  toolType: AiTabType,
  prompt: PendingPrompt,
  projectArgs: readonly string[],
  withPrompt = true
): string[] {
  const args: string[] = []
  if (toolType === 'claude' && prompt.mode && !projectArgs.some((arg) => PERMISSION_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) {
    args.push('--permission-mode', prompt.mode)
  }
  const text = prompt.text.trim()
  if (withPrompt && text) args.push(text.startsWith('-') ? ` ${text}` : text)
  return args
}

/**
 * One-shot hand-off from the prompt box to the tab it opens. Kept in memory only:
 * after a restart the tab resumes its session instead of sending the prompt again.
 */
const pendingPrompts = new Map<string, PendingPrompt>()

export function setPendingPrompt(tabId: string, prompt: PendingPrompt): void {
  pendingPrompts.set(tabId, prompt)
}

export function takePendingPrompt(tabId: string): PendingPrompt | undefined {
  const prompt = pendingPrompts.get(tabId)
  pendingPrompts.delete(tabId)
  return prompt
}

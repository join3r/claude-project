import type { Project, Task, TaskAutopilot } from './types'

/**
 * Autopilot (desk redesign decision 7), the parts both processes read: where a
 * task's run puts it in the inbox, and the one line a row says about it. Main's
 * `AutopilotRunner` (src/main/autopilot.ts) moves the run on.
 */

/** Autopilot handed the task back and you haven't written to it since: it sits in Needs you. */
export function autopilotNeedsYou(task: Task): boolean {
  const autopilot = task.autopilot
  if (autopilot?.phase !== 'stopped') return false
  return (autopilot.stoppedAt ?? 0) > (task.lastInteractedAt ?? 0)
}

/** Main is at work on the task with no agent turn to show it (Codex reviewing, landing): it sits in Working. */
export function autopilotBusy(task: Task): boolean {
  const phase = task.autopilot?.phase
  return phase === 'reviewing' || phase === 'landing'
}

/** Still running: not handed back. */
export function autopilotActive(task: Task): boolean {
  return !!task.autopilot && task.autopilot.phase !== 'stopped'
}

/** The row's line for a run still going, or null (`working` reads as the agent's own line). */
export function autopilotLine(autopilot: TaskAutopilot | undefined): string | null {
  switch (autopilot?.phase) {
    case 'reviewing': return 'Autopilot · Codex reviewing'
    case 'fixing': return 'Autopilot · fixing Codex’s findings'
    case 'landing': return 'Autopilot · landing'
    default: return null
  }
}

/** An archived task Autopilot landed: the Done tab's "autopilot" mark. */
export function autopilotLanded(task: Task): boolean {
  return task.autopilot?.phase === 'landing'
}

/**
 * Where Autopilot runs: a project on this machine. Over SSH and on a DevTool
 * server the agent and the git live elsewhere, and a shell project runs no Claude.
 */
export function autopilotSupported(project: Pick<Project, 'ssh' | 'host' | 'shellCommand'>): boolean {
  return !project.ssh && !project.host && !project.shellCommand
}

/** The task handed back with `reason`. */
export function stoppedAutopilot(autopilot: TaskAutopilot, reason: string, now: number): TaskAutopilot {
  const { base: _base, ...rest } = autopilot
  return { ...rest, phase: 'stopped', reason, stoppedAt: now }
}

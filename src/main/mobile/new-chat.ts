import { randomUUID } from 'crypto'
import { CLAUDE_CHAT_LABEL, isShellCommandProject, type ProjectsData, type Tab } from '../../shared/types'
import { AppErrorCode } from '../../../protocol/ts/index.ts'
import { canAddTabType, findTaskInProject, mapTaskInProject } from '../../shared/streams'
import { addTabToPane } from '../../shared/panes'
import { isVisibleOnMobile } from './inbox'

/**
 * `chat.new` (SPEC.md §8.2): a new Claude chat tab at the end of a task's first pane.
 * Main commits it itself, so no window has to be open; the
 * windows rebase onto the commit, and none of them switches to the new tab.
 */

export type NewChatResult =
  | { ok: true; data: ProjectsData; tabId: string }
  | { ok: false; code: string; message: string }

export function addChatTab(data: ProjectsData, taskId: string, ids: () => string = randomUUID): NewChatResult {
  for (const project of data.projects) {
    const task = findTaskInProject(project, taskId)
    if (!task) continue
    if (!isVisibleOnMobile(project)) break
    // A shell-command project runs one command, not agents; its tab bar has no Claude button.
    if (isShellCommandProject(project)) return { ok: false, code: AppErrorCode.Unsupported, message: 'This project runs a shell command, not Claude' }
    // One agent per task: `addTabToPane` would drop a second one, so say so instead.
    // (Retired with `chat.new` in favour of `task.new`.)
    if (!canAddTabType(task, 'claude-chat')) return { ok: false, code: AppErrorCode.Unsupported, message: 'This task already has an agent' }
    const tab: Tab = { id: ids(), type: 'claude-chat', title: CLAUDE_CHAT_LABEL, sessionId: ids() }
    const next: ProjectsData = {
      ...data,
      projects: data.projects.map((p) =>
        p !== project ? p : mapTaskInProject(p, task.id, (t) => addTabToPane(t, 0, tab, { activate: t.panes.length === 0 }))
      )
    }
    return { ok: true, data: next, tabId: tab.id }
  }
  return { ok: false, code: AppErrorCode.NotFound, message: 'No such task' }
}

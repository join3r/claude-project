import { randomUUID } from 'crypto'
import { CLAUDE_CHAT_LABEL, isShellCommandProject, type ProjectsData, type Tab } from '../../shared/types'
import { AppErrorCode } from '../../../protocol/ts/index.ts'
import { findTaskInProject, mapTaskInProject, paneTabs, withPaneTabs } from '../../shared/streams'
import { isVisibleOnMobile } from './inbox'

/**
 * `chat.new` (SPEC.md §8.2): a new Claude chat tab at the end of a task's left pane.
 * Main commits it itself, as idle cleanup does, so no window has to be open; the
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
    const tab: Tab = { id: ids(), type: 'claude-chat', title: CLAUDE_CHAT_LABEL, sessionId: ids() }
    const next: ProjectsData = {
      ...data,
      projects: data.projects.map((p) =>
        p !== project ? p : mapTaskInProject(p, task.id, (t) => withPaneTabs(t, 'left', [...paneTabs(t, 'left'), tab]))
      )
    }
    return { ok: true, data: next, tabId: tab.id }
  }
  return { ok: false, code: AppErrorCode.NotFound, message: 'No such task' }
}

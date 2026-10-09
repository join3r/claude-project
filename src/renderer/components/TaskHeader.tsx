import React, { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince } from '../context/TabStatusContext'
import { useAllAgentActivity } from '../agentActivity'
import { pinnedItemKey } from '../../shared/types'
import type { PinnedItem, Project, Stream, Task } from '../../shared/types'
import { ContextMenu, type ContextMenuItem } from './ui'
import type { MenuAnchor } from '../hooks/useMenuPosition'
import ProjectTileBadge from './ProjectTileBadge'
import { isSettled, isSnoozed, snoozePresets, taskActivity } from './inbox'
import { taskAgentTab, taskStatusChip, type TaskChipTone } from './taskHeaderState'
import { useCloseTask } from './sidebar/useCloseTask'
import { landingActionBlocker } from './sidebar/closeRules'
import { useTaskLandingActions } from './useTaskLandingActions'
import { canLandTask, useLandingOp, useStreamAhead } from '../taskLanding'
import { useTabStatusStore } from '../context/TabStatusContext'

const iconBtnCls = 'bg-transparent border-0 cursor-pointer w-[30px] h-6 rounded-md leading-none inline-flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-3 [-webkit-app-region:no-drag] transition-colors duration-(--motion-fast)'

/** The state label's dot, in the sidebar's colours. */
const STATE_DOT_CLS: Record<TaskChipTone, string> = {
  attention: 'bg-status-attention',
  working: 'bg-status-working status-pulse',
  turn: 'bg-info',
  quiet: 'bg-border-strong'
}

/**
 * The bar above a task, on one line: **project** › stream › task (the stream is
 * left out when it is `main`), then a quiet state label. Right side: the
 * caller's tools (new terminal / browser, Files / Git / Notes, IDE) and the
 * task menu, which also closes the task. On a project's Home it is just the project.
 */
export default function TaskHeader({
  project,
  task,
  stream,
  title,
  tools
}: {
  project: Project
  task: Task | null
  stream: Stream | undefined
  /** Full text for the hover, the same as the window title. */
  title: string
  tools: React.ReactNode
}): React.ReactElement {
  const {
    config, effectiveTheme, renameTask, convertClaudeTab, pinnedItems, togglePinnedItem,
    settleTask, unsettleTask, snoozeTask, unsnoozeTask
  } = useApp()
  const allStatuses = useAllTabStatuses()
  const statusSince = useAllTabStatusSince()
  const activities = useAllAgentActivity()
  const closeTaskFlow = useCloseTask()
  const landingActions = useTaskLandingActions()
  const tabStatusStore = useTabStatusStore()
  const landingOp = useLandingOp(task?.id ?? '')
  const streamAhead = useStreamAhead(task?.id ?? '')
  const [menu, setMenu] = useState<(MenuAnchor & { page: 'main' | 'snooze' }) | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const [now, setNow] = useState(() => Date.now())

  const chip = task ? taskStatusChip(task, allStatuses, statusSince, now) : null
  const waiting = chip?.tone === 'attention'
  // "Needs you · 4m" counts up while it waits.
  useEffect(() => {
    if (!waiting) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [waiting])

  useEffect(() => { setRenaming(null) }, [task?.id])
  useEffect(() => {
    if (renaming !== null) renameRef.current?.select()
  }, [renaming !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  const showStream = !!task && !!stream && !stream.isMain
  const showIcon = config?.showProjectIcons ?? false

  const agentTab = task ? taskAgentTab(task) : undefined
  const activity = task ? taskActivity(task, allStatuses, activities) : {}
  const chipTitle = [activity.line, activity.tooltip].filter(Boolean).join('\n') || undefined

  const commitRename = () => {
    if (!task || renaming === null) return
    const name = renaming.trim()
    if (name && name !== task.name) renameTask(project.id, task.id, name)
    setRenaming(null)
  }

  const menuItems = (): ContextMenuItem[] => {
    if (!task || !menu) return []
    if (menu.page === 'snooze') {
      return snoozePresets(Date.now()).map(preset => ({
        label: preset.hint ? `${preset.label} (${preset.hint})` : preset.label,
        onSelect: () => snoozeTask(project.id, task.id, { until: preset.until, untilAttention: preset.untilAttention })
      }))
    }
    const items: ContextMenuItem[] = []
    // Same session, other face: the Claude tab flips between terminal and chat.
    if (agentTab && (agentTab.type === 'claude' || agentTab.type === 'claude-chat')) {
      const to = agentTab.type === 'claude' ? 'claude-chat' : 'claude'
      items.push({
        label: to === 'claude' ? 'Switch to terminal' : 'Switch to chat',
        onSelect: () => convertClaudeTab(project.id, task.id, agentTab.id, to)
      })
    }
    // A task with a worktree of its own lands into its stream; not while its agent works.
    if (stream && canLandTask(project, task)) {
      const blocked = landingActionBlocker(task, (tabId) => tabStatusStore.getStatus(tabId), !!landingOp)
      items.push({
        label: `Land into ${stream.name}`,
        dividerBefore: items.length > 0,
        disabled: !!blocked,
        hint: blocked ?? undefined,
        onSelect: () => { void landingActions.land(project, task) }
      })
      items.push({
        label: `Update from ${stream.name}`,
        disabled: !!blocked,
        hint: blocked ?? undefined,
        onSelect: () => { void landingActions.update(project, task) }
      })
    }
    items.push({ label: 'Rename', dividerBefore: items.length > 0, onSelect: () => setRenaming(task.name) })
    const pin: PinnedItem = { type: 'task', projectId: project.id, streamId: stream?.id ?? '', taskId: task.id }
    const pinned = (pinnedItems ?? []).some(item => pinnedItemKey(item) === pinnedItemKey(pin))
    items.push({ label: pinned ? 'Unpin' : 'Pin', onSelect: () => togglePinnedItem(pin) })
    const settled = isSettled(task)
    items.push({
      label: settled ? 'Back to Inbox' : 'Done for now',
      dividerBefore: true,
      onSelect: () => (settled ? unsettleTask : settleTask)(project.id, task.id)
    })
    if (isSnoozed(task, Date.now())) {
      items.push({ label: 'Wake now', onSelect: () => unsnoozeTask(project.id, task.id) })
    } else {
      items.push({ label: 'Snooze…', onSelect: () => setMenu({ ...menu, page: 'snooze' }) })
    }
    items.push({
      label: 'Close task',
      danger: true,
      dividerBefore: true,
      onSelect: () => { void closeTaskFlow.closeTask(project.id, task.id) }
    })
    return items
  }

  return (
    <>
      <div className="content-toolbar flex items-center gap-2 h-[38px] shrink-0 pl-3 pr-1.5 border-b-[0.5px] border-border [-webkit-app-region:drag]">
        {showIcon && <ProjectTileBadge project={project} theme={effectiveTheme} size={16} />}
        <div className="flex-1 min-w-0 flex items-center gap-1.5 whitespace-nowrap text-sm text-text-muted" title={title}>
          <span className="font-semibold text-text truncate shrink-0 max-w-[40%]">{project.name}</span>
          {showStream && (
            <>
              <span className="text-text-subtle">›</span>
              <span className="font-mono text-text truncate shrink-0 max-w-[30%]">{stream.name}</span>
              {!!streamAhead && task.workspace && (
                <span
                  className="font-mono text-xs text-text-subtle shrink-0"
                  title={`${stream.name} has ${streamAhead === 1 ? '1 commit' : `${streamAhead} commits`} this task doesn't. Update from ${stream.name} in the task menu.`}
                  data-testid="task-header-stream-ahead"
                >
                  +{streamAhead}
                </span>
              )}
            </>
          )}
          {task && <span className="text-text-subtle">›</span>}
          {task && (renaming !== null ? (
            <input
              ref={renameRef}
              aria-label="Task name"
              className="flex-1 min-w-0 bg-field border border-border-focus text-text text-sm px-1 py-0 rounded-sm outline-none [-webkit-app-region:no-drag]"
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <span className="text-text truncate min-w-0" data-testid="task-header-name">{task.name}</span>
          ))}
        </div>
        {chip && (
          <span className="shrink-0 inline-flex items-center gap-1.5 text-xs text-text-muted tabular-nums" title={chipTitle}>
            <span className={`w-1.5 h-1.5 rounded-full ${STATE_DOT_CLS[chip.tone]}`} />
            {chip.label}
          </span>
        )}
        <div className="flex items-center gap-0.5 shrink-0">
          {tools}
          {task && (
            <button
              type="button"
              className={iconBtnCls}
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              title="Task actions"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                setMenu(menu ? null : { x: rect.left, y: rect.bottom + 4, page: 'main' })
              }}
            >
              <MoreHorizontal size={15} />
            </button>
          )}
        </div>
      </div>
      <ContextMenu menu={menu} items={menuItems()} onClose={() => setMenu(null)} />
      {closeTaskFlow.dialog}
    </>
  )
}

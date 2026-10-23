import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, MoreHorizontal } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince } from '../context/TabStatusContext'
import { useAllAgentActivity } from '../agentActivity'
import { pinnedItemKey } from '../../shared/types'
import type { PinnedItem, Project, Stream, Task } from '../../shared/types'
import { ContextMenu, type ContextMenuItem } from './ui'
import type { MenuAnchor } from '../hooks/useMenuPosition'
import ProjectTileBadge from './ProjectTileBadge'
import { isSnoozed, snoozePresets, taskActivity } from './inbox'
import { taskAgentTab, taskStatusChip, type TaskChipTone } from './taskHeaderState'
import { useCloseTask } from './sidebar/useCloseTask'
import { landingActionBlocker } from './sidebar/closeRules'
import { useTaskLandingActions } from './useTaskLandingActions'
import { canLandTask, useLandingOp, useStreamAhead } from '../taskLanding'
import { useTabStatusStore } from '../context/TabStatusContext'
import { featureUnavailableReason } from '../../shared/project-features'
import { isEphemeralProject } from '../../shared/types'
import { taskMoveBlocker } from '../../shared/streams'
import { streamRunCommand } from '../../shared/stream-run'
import { EntityMenuPopup, type EntityMenuTarget } from './menus/EntityMenus'
import { SidebarStreamRunBadge } from './StreamRunControls'
import { useMoveTask } from '../hooks/useTaskMenuActions'

const iconBtnCls = 'bg-transparent border-0 cursor-pointer w-[30px] h-6 rounded-md leading-none inline-flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-3 [-webkit-app-region:no-drag] transition-colors duration-(--motion-fast)'

const crumbMenuBtnCls = 'bg-transparent border-0 cursor-pointer size-5 -ml-1 rounded-sm shrink-0 inline-flex items-center justify-center text-text-subtle hover:text-text hover:bg-surface-3 [-webkit-app-region:no-drag] transition-colors duration-(--motion-fast)'

/** Where a breadcrumb's dropdown opens: under it, at its left edge. */
function belowAnchor(e: React.MouseEvent): MenuAnchor {
  const rect = e.currentTarget.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom + 4 }
}

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
 * task menu, which also closes the task. The project name opens the project's
 * Home; its chevron (or a right-click) opens the project menu, which for a task
 * in `main` also leads to main's stream menu. The stream name opens the stream
 * menu, and its app's ▶ badge shows beside it while the app runs or after it
 * failed. On a project's Home it is just the project, with its menu.
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
    snoozeTask, unsnoozeTask, setSelectedTaskId
  } = useApp()
  const allStatuses = useAllTabStatuses()
  const statusSince = useAllTabStatusSince()
  const activities = useAllAgentActivity()
  const closeTaskFlow = useCloseTask()
  const landingActions = useTaskLandingActions()
  const tabStatusStore = useTabStatusStore()
  const landingOp = useLandingOp(task?.id ?? '')
  const streamAhead = useStreamAhead(task?.id ?? '')
  const [menu, setMenu] = useState<(MenuAnchor & { page: 'main' | 'snooze' | 'move' }) | null>(null)
  const [entityMenu, setEntityMenu] = useState<EntityMenuTarget | null>(null)
  const closeEntityMenu = React.useCallback(() => setEntityMenu(null), [])
  const moveTask = useMoveTask()
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
  // A "task in a directory" has no project you chose to have, so no project or stream menu.
  const menusOn = !isEphemeralProject(project)
  const openProjectMenu = (at: MenuAnchor): void => setEntityMenu({
    ...at,
    kind: 'project',
    projectId: project.id,
    // main has no name of its own in the breadcrumb: its menu is a page of the project's.
    ...(task && stream?.isMain ? { withStreamId: stream.id } : {})
  })
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
    if (menu.page === 'move') {
      return project.streams.filter(other => other.id !== stream?.id).map(other => {
        const blocked = stream ? taskMoveBlocker(task, stream, other) : null
        return {
          label: other.name,
          disabled: !!blocked,
          hint: blocked ? 'has its own worktree' : other.workspace ? `⎇ ${other.workspace.branchName}` : undefined,
          onSelect: () => moveTask(project.id, task.id, other.id)
        }
      })
    }
    const items: ContextMenuItem[] = []
    // Same session, other face: the Claude tab flips between terminal and chat.
    if (agentTab && (agentTab.type === 'claude' || agentTab.type === 'claude-chat')) {
      const to = agentTab.type === 'claude' ? 'claude-chat' : 'claude'
      const blocked = to === 'claude-chat' ? featureUnavailableReason(project, 'chat') : null
      items.push({
        label: to === 'claude' ? 'Switch to terminal' : 'Switch to chat',
        disabled: !!blocked,
        hint: blocked ?? undefined,
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
    if (project.streams.length > 1 && !isEphemeralProject(project)) {
      items.push({ label: 'Move to stream…', onSelect: () => setMenu({ ...menu, page: 'move' }) })
    }
    if (isSnoozed(task, Date.now())) {
      items.push({ label: 'Wake now', dividerBefore: true, onSelect: () => unsnoozeTask(project.id, task.id) })
    } else {
      items.push({ label: 'Snooze…', dividerBefore: true, onSelect: () => setMenu({ ...menu, page: 'snooze' }) })
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
          {task ? (
            <button
              type="button"
              className="bg-transparent border-0 p-0 font-semibold text-sm text-text truncate shrink-0 max-w-[40%] cursor-pointer hover:underline [-webkit-app-region:no-drag]"
              title={`Open ${project.name} home`}
              onClick={() => setSelectedTaskId(null)}
              onContextMenu={menusOn ? (e) => { e.preventDefault(); openProjectMenu({ x: e.clientX, y: e.clientY }) } : undefined}
              data-testid="task-header-project"
            >
              {project.name}
            </button>
          ) : (
            <span
              className="font-semibold text-text truncate shrink-0 max-w-[40%]"
              onContextMenu={menusOn ? (e) => { e.preventDefault(); openProjectMenu({ x: e.clientX, y: e.clientY }) } : undefined}
            >{project.name}</span>
          )}
          {menusOn && (
            <button
              type="button"
              className={crumbMenuBtnCls}
              aria-haspopup="menu"
              aria-expanded={entityMenu?.kind === 'project'}
              title={`${project.name} actions`}
              onClick={(e) => openProjectMenu(belowAnchor(e))}
              data-testid="task-header-project-menu"
            >
              <ChevronDown size={12} />
            </button>
          )}
          {task && stream?.isMain && (
            <SidebarStreamRunBadge projectId={project.id} streamId={stream.id} command={streamRunCommand(project, stream)} />
          )}
          {showStream && (
            <>
              <span className="text-text-subtle">›</span>
              <button
                type="button"
                className="bg-transparent border-0 p-0 font-mono text-sm text-text truncate shrink-0 max-w-[30%] cursor-pointer hover:underline [-webkit-app-region:no-drag]"
                aria-haspopup="menu"
                aria-expanded={entityMenu?.kind === 'stream'}
                title={`${stream.name}: stream actions`}
                onClick={(e) => setEntityMenu({ ...belowAnchor(e), kind: 'stream', projectId: project.id, streamId: stream.id })}
                onContextMenu={(e) => { e.preventDefault(); setEntityMenu({ x: e.clientX, y: e.clientY, kind: 'stream', projectId: project.id, streamId: stream.id }) }}
                data-testid="task-header-stream"
              >
                {stream.name}
              </button>
              <span className="shrink-0 flex items-center [-webkit-app-region:no-drag]">
                <SidebarStreamRunBadge projectId={project.id} streamId={stream.id} command={streamRunCommand(project, stream)} />
              </span>
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
      <EntityMenuPopup menu={entityMenu} onClose={closeEntityMenu} />
      {closeTaskFlow.dialog}
    </>
  )
}

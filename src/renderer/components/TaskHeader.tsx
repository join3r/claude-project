import React, { useEffect, useRef, useState } from 'react'
import { GitBranch, MoreHorizontal, X } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince } from '../context/TabStatusContext'
import { useAllAgentActivity } from '../agentActivity'
import { isRemoteProject, isShellCommandProject, pinnedItemKey } from '../../shared/types'
import type { GitDiffSummary, PinnedItem, Project, Stream, Task } from '../../shared/types'
import { useGitPosture } from '../hooks/useGitPosture'
import { ContextMenu, type ContextMenuItem } from './ui'
import type { MenuAnchor } from '../hooks/useMenuPosition'
import ProjectTileBadge from './ProjectTileBadge'
import { isSettled, isSnoozed, snoozePresets, taskActivity } from './inbox'
import { taskAgentLabel, taskAgentTab, taskStatusChip, type TaskChipTone } from './taskHeaderState'
import { useCloseTask } from './sidebar/useCloseTask'

const iconBtnCls = 'bg-transparent border-0 cursor-pointer w-[30px] h-6 rounded-md leading-none inline-flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-3 [-webkit-app-region:no-drag] transition-colors duration-(--motion-fast)'

const CHIP_CLS: Record<TaskChipTone, string> = {
  attention: 'text-status-attention bg-[color-mix(in_srgb,var(--color-status-attention)_16%,transparent)]',
  working: 'text-text-muted bg-surface-3',
  turn: 'text-info bg-[color-mix(in_srgb,var(--color-info)_14%,transparent)]',
  quiet: 'text-text-subtle bg-surface-3'
}

/**
 * The bar above a task: who it belongs to on the first line (tile, **project** ›
 * stream ⎇ branch), the task itself on the second (name, status chip, agent).
 * Right side: git `+N −N`, the caller's tools (Files / Git / Notes and friends),
 * the task menu and Close task. On a project's Home it is just the project line.
 */
export default function TaskHeader({
  project,
  task,
  stream,
  projectDir,
  gitSummary,
  title,
  tools
}: {
  project: Project
  task: Task | null
  stream: Stream | undefined
  /** The task's working folder (its stream's worktree, else the project's). */
  projectDir: string
  gitSummary: GitDiffSummary | null
  /** Full text for the hover, the same as the window title. */
  title: string
  tools: React.ReactNode
}): React.ReactElement {
  const {
    effectiveTheme, renameTask, convertClaudeTab, pinnedItems, togglePinnedItem,
    settleTask, unsettleTask, snoozeTask, unsnoozeTask
  } = useApp()
  const allStatuses = useAllTabStatuses()
  const statusSince = useAllTabStatusSince()
  const activities = useAllAgentActivity()
  const closeTaskFlow = useCloseTask()
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

  // A worktree stream names its branch; on the project folder ask git.
  const local = !isRemoteProject(project) && !isShellCommandProject(project) && !!project.directory
  const folderBranch = useGitPosture(projectDir, !!task && local && !stream?.workspace)?.branch ?? null
  const branch = stream?.workspace?.branchName ?? folderBranch
  const showStream = !!task && !!stream && !stream.isMain

  const agentLabel = task ? taskAgentLabel(task) : null
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
    return items
  }

  const hasGitSummary = !!gitSummary && (gitSummary.added > 0 || gitSummary.deleted > 0)

  return (
    <>
      <div className="content-toolbar flex items-center gap-2 px-2 py-1 bg-surface-2 border-b-[0.5px] border-border [-webkit-app-region:drag]">
        <ProjectTileBadge project={project} theme={effectiveTheme} size={task ? 28 : 20} />
        <div className="flex-1 min-w-0 flex flex-col justify-center leading-tight" title={title}>
          <div className={`flex items-center gap-1 min-w-0 whitespace-nowrap ${task ? 'text-xs text-text-muted' : 'text-sm text-text'}`}>
            <span className="font-semibold text-text truncate shrink-0 max-w-[50%]">{project.name}</span>
            {showStream && (
              <>
                <span className="text-text-subtle">›</span>
                <span className="truncate min-w-0">{stream.name}</span>
              </>
            )}
            {task && branch && (
              <span className="inline-flex items-center gap-0.5 ml-1 text-text-subtle min-w-0" title={`Branch ${branch}`}>
                <GitBranch size={11} className="shrink-0" />
                <span className="font-mono truncate">{branch}</span>
              </span>
            )}
          </div>
          {task && (
            <div className="flex items-center gap-1.5 min-w-0 whitespace-nowrap">
              {renaming !== null ? (
                <input
                  ref={renameRef}
                  aria-label="Task name"
                  className="flex-1 min-w-0 bg-field border border-border-focus text-text text-sm font-medium px-1 py-0 rounded-sm outline-none [-webkit-app-region:no-drag]"
                  value={renaming}
                  onChange={(e) => setRenaming(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    else if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              ) : (
                <span className="text-sm font-medium text-text truncate min-w-0" data-testid="task-header-name">{task.name}</span>
              )}
              {chip && (
                <span
                  className={`shrink-0 rounded-full px-1.5 text-2xs font-semibold leading-[1.5] tabular-nums ${CHIP_CLS[chip.tone]}`}
                  title={chipTitle}
                >
                  {chip.label}
                </span>
              )}
              {agentLabel && <span className="shrink-0 text-xs text-text-subtle">{agentLabel}</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {hasGitSummary && gitSummary && (
            <span
              className="inline-flex items-center gap-1.5 mr-1 text-sm [font-variant-numeric:tabular-nums]"
              title={`${gitSummary.added} added, ${gitSummary.deleted} removed`}
            >
              {gitSummary.added > 0 && <span className="text-success">+{gitSummary.added}</span>}
              {gitSummary.deleted > 0 && <span className="text-danger">−{gitSummary.deleted}</span>}
            </span>
          )}
          {tools}
          {task && (
            <>
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
              <button
                type="button"
                className={`${iconBtnCls} hover:text-danger`}
                title="Close task"
                onClick={() => { void closeTaskFlow.closeTask(project.id, task.id) }}
              >
                <X size={15} />
              </button>
            </>
          )}
        </div>
      </div>
      <ContextMenu menu={menu} items={menuItems()} onClose={() => setMenu(null)} />
      {closeTaskFlow.dialog}
    </>
  )
}

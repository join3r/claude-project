import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Folders, List, Search, X } from 'lucide-react'
import type { DeskScope, DeskTab, Project } from '../../../shared/types'
import { autopilotLanded } from '../../../shared/autopilot'
import { useApp } from '../../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince } from '../../context/TabStatusContext'
import { useAllAgentActivity } from '../../agentActivity'
import { useProjectArchives } from '../../hooks/archiveStore'
import { useResizeHandle } from '../../hooks/useResizeHandle'
import { useTaskDiffSummaries } from '../../hooks/useTaskDiffSummaries'
import { paletteEvents } from '../../palette/paletteEvents'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import type { MenuAnchor } from '../../hooks/useMenuPosition'
import ProjectTileBadge from '../ProjectTileBadge'
import { formatRelativeAge, groupInboxByProject, inboxSources, isSnoozed, partitionInbox, taskActivity, type InboxEntry } from '../inbox'
import type { NewTaskSubmission } from '../newTask'
import DeskCompose from './DeskCompose'
import DeskRow, { AutopilotMark, bestActivity, type DeskRowKind } from './DeskRow'
import DeskScopeMenu from './DeskScopeMenu'
import DeskSnoozeMenu, { type DeskSnoozeRequest } from './DeskSnoozeMenu'
import { deskEvents } from './deskEvents'
import {
  DONE_WINDOW_MS, checkRows, checkedRows, deskLists, deskTabCounts, doneEntries, keyTarget, liveScope, nextNeedsYou, pinnedFirst, scopeLabel, scopeSources, shownRows, stepRow, taskBackground,
  type DeskLists, type DoneEntry, type InboxRename
} from './deskInbox'
import { stopBackground } from './useDeskDone'
import { isTaskJumpKey, jumpDigit } from '../../hooks/useMetaHeld'

export const DESK_DEFAULT_WIDTH = 420
const clampDeskWidth = (width: number): number => Math.min(640, Math.max(340, width))

const TABS: ReadonlyArray<{ id: DeskTab; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'working', label: 'Working' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'done', label: 'Done' }
]

/** A key the row shortcuts must not steal: typing in a field, the terminal, an editor. */
function typingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.closest('.xterm, .monaco-editor')
}

function GroupHead({ label, count, tone, hint }: { label: string; count: number; tone?: 'needs' | 'answered'; hint?: string }): React.ReactElement {
  const color = tone === 'needs' ? 'text-needs' : tone === 'answered' ? 'text-answered' : 'text-text-muted'
  return (
    <div className="flex items-center justify-between px-[18px] pt-3.5 pb-1.5 text-xs font-semibold uppercase tracking-[0.07em]" data-testid="desk-group">
      <span className={color}>{label} · {count}</span>
      {hint && <span className="normal-case tracking-normal font-normal text-text-muted">{hint}</span>}
    </div>
  )
}

/** A project header in "Group by project": tile and name; a click scopes the column to it. */
function ProjectGroupHead({ project, count, theme, showTile, onScope }: { project: Project; count: number; theme: 'dark' | 'light'; showTile: boolean; onScope: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 px-[18px] pt-3.5 pb-1.5 bg-transparent border-0 text-left text-xs font-semibold text-text-muted cursor-pointer hover:text-text"
      title={`Show only ${project.name}`}
      onClick={onScope}
      data-testid="desk-project-group"
    >
      {showTile && <ProjectTileBadge project={project} theme={theme} size={14} />}
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{project.name} · {count}</span>
    </button>
  )
}

/** A task a snooze applies to. */
interface Target { projectId: string; taskId: string }

const bulkCls = 'px-2 py-1 rounded-md border-0 bg-border text-sm text-text cursor-pointer hover:bg-border-strong whitespace-nowrap'

/** In place of the tabs while rows are ticked: how many, and what to do with them all. */
function BulkBar({ entries, total, onDone, onSnooze, onWake, onRead, onRemove, onAll, onClear }: {
  entries: readonly InboxEntry[]
  total: number
  onDone: () => void
  onSnooze: (e: React.MouseEvent<HTMLButtonElement>) => void
  onWake: () => void
  onRead: () => void
  onRemove: () => void
  onAll: () => void
  onClear: () => void
}): React.ReactElement {
  const now = Date.now()
  const anySnoozed = entries.some(({ task }) => isSnoozed(task, now))
  const anyAwake = entries.some(({ task }) => !isSnoozed(task, now))
  const anyUnread = entries.some(entry => entry.unread)
  return (
    <div className="flex gap-1 items-center min-h-[28px]" data-testid="desk-bulk-bar">
      <button type="button" className="flex items-center p-1 rounded-md bg-transparent border-0 text-text-muted cursor-pointer hover:text-text hover:bg-surface-3" title="Clear selection (Esc)" aria-label="Clear selection" onClick={onClear}>
        <X size={14} />
      </button>
      <span className="text-sm font-semibold text-text tabular-nums mr-1" data-testid="desk-bulk-count">{entries.length} selected</span>
      {entries.length < total && (
        <button type="button" className="px-1.5 py-1 rounded-md border-0 bg-transparent text-sm text-text-muted cursor-pointer hover:text-text" title="Select every row (⌘A)" onClick={onAll}>All</button>
      )}
      <span className="flex-1" />
      <button type="button" className={bulkCls} title="Done: land each and close (E)" onClick={onDone} data-testid="desk-bulk-done">✓ Done</button>
      {anyAwake && <button type="button" className={bulkCls} title="Snooze (S)" onClick={onSnooze} data-testid="desk-bulk-snooze">Snooze</button>}
      {anySnoozed && <button type="button" className={bulkCls} title="Wake now (W)" onClick={onWake} data-testid="desk-bulk-wake">Wake</button>}
      <button type="button" className={bulkCls} title={anyUnread ? 'Mark read (U)' : 'Mark unread (U)'} onClick={onRead} data-testid="desk-bulk-read">{anyUnread ? 'Read' : 'Unread'}</button>
      <button type="button" className={bulkCls} title="Remove without landing (⌫)" onClick={onRemove} data-testid="desk-bulk-remove">Remove</button>
    </div>
  )
}

/** Which list an entry of the Inbox tab came from, for its row's preview and actions. */
function inboxKind(lists: DeskLists, entry: InboxEntry): DeskRowKind {
  if (lists.needsYou.includes(entry)) return 'needsYou'
  if (lists.answered.includes(entry)) return 'answered'
  return 'waiting'
}

/**
 * The desk's left column (redesign step 1): scope menu and the bar button, the
 * compose box, the Inbox / Working / Snoozed / Done tabs and the mail-style
 * list. Rows offer ✓ Done (E) and Snooze (S); W wakes, U marks unread and ⌫
 * removes; ⌥↓ / ⌥↑ walk the list, ⌘J jumps to the next task that needs you
 * and ⌘1–9 opens the row with that number (the numbers show while ⌘ is held).
 * Pinned tasks sit at the top of their group, and the header's toggle groups
 * the list by project. ⌘-click and ⇧-click tick rows (X ticks the hovered
 * one, ⌘A all of them once one is ticked); while any is ticked, the tabs give
 * way to a bar whose actions, and the row keys, act on every ticked row. Esc
 * clears it. The modals (Settings, New project, the row menu) stay
 * with the Sidebar that hosts this column.
 */
export default function DeskColumn({
  projects, composeProjects, pinnedIds, pinnedTaskIds, pinnedStreams, offlineIds, missingDirIds, onSelectTask, onTaskContextMenu, onDone, onRemove, onCompose, footer, rename
}: {
  /** Every project with tasks the column may list, ad-hoc ones included. */
  projects: readonly Project[]
  /** Where compose and the scope menu may aim: the projects you added. */
  composeProjects: readonly Project[]
  pinnedIds: ReadonlySet<string>
  /** Pinned tasks: first in their group, with a pin. */
  pinnedTaskIds: ReadonlySet<string>
  /** Pinned streams, offered first in the scope menu. */
  pinnedStreams: ReadonlyArray<{ projectId: string; streamId: string }>
  /** Projects on a DevTool server that isn't online: their rows are greyed. */
  offlineIds: ReadonlySet<string>
  missingDirIds: ReadonlySet<string>
  onSelectTask: (projectId: string, taskId: string) => void
  onTaskContextMenu: (e: React.MouseEvent, projectId: string, taskId: string) => void
  /** Resolves once the Done has run, so a bulk Done lands one task at a time. */
  onDone: (projectId: string, taskId: string) => Promise<void>
  /** ⌫ on a row: remove the task (its own worktree goes without landing, after a confirm; `confirmed` when a bulk remove asked already). */
  onRemove: (projectId: string, taskId: string, confirmed?: boolean) => Promise<void>
  onCompose: (submission: NewTaskSubmission) => void
  footer: ReadonlyArray<{ label: string; onClick: () => void }>
  rename: InboxRename | null
}): React.ReactElement {
  const {
    config, updateConfig, desk, updateDesk, selectedTaskId, setSelectedProjectId, selectProjectHome, effectiveTheme,
    snoozeTask, unsnoozeTask, markTaskUnread, markTaskVisited, showArchived, reopenTask
  } = useApp()
  const allStatuses = useAllTabStatuses()
  const statusSince = useAllTabStatusSince()
  const activities = useAllAgentActivity()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  const width = clampDeskWidth(desk.width ?? DESK_DEFAULT_WIDTH)
  const resize = useResizeHandle({ width, onWidthChange: (w) => updateDesk({ width: clampDeskWidth(w) }), edge: 'right' })
  const tab: DeskTab = desk.tab ?? 'inbox'
  const scope: DeskScope | null = useMemo(() => liveScope(projects, desk.scope), [projects, desk.scope])

  const lists = useMemo(() => {
    const raw = deskLists(partitionInbox(scopeSources(inboxSources([...projects]), scope), allStatuses, statusSince, now))
    return {
      needsYou: pinnedFirst(raw.needsYou, pinnedTaskIds),
      answered: pinnedFirst(raw.answered, pinnedTaskIds),
      waiting: pinnedFirst(raw.waiting, pinnedTaskIds),
      working: pinnedFirst(raw.working, pinnedTaskIds),
      snoozed: pinnedFirst(raw.snoozed, pinnedTaskIds)
    }
  }, [projects, scope, allStatuses, statusSince, now, pinnedTaskIds])
  // Lines added and removed on every row but the snoozed ones, as on the phone.
  const diffSources = useMemo(
    () => [...lists.needsYou, ...lists.answered, ...lists.waiting, ...lists.working].map(({ project, task }) => ({ project, task })),
    [lists]
  )
  const diffs = useTaskDiffSummaries(diffSources)
  const grouped = config?.inboxLayout === 'grouped'
  const showTiles = config?.showProjectIcons ?? false
  const counts = deskTabCounts(lists)

  const [showOlder, setShowOlder] = useState(false)
  const archiveIds = useMemo(
    () => projects.filter(p => (p.archivedStreamCount ?? 0) > 0 || p.streams.some(s => (s.archivedTaskCount ?? 0) > 0)).map(p => p.id),
    [projects]
  )
  const archives = useProjectArchives(archiveIds, tab === 'done')
  const done = useMemo(
    () => (tab === 'done' ? doneEntries(projects, archives, scope, showOlder ? null : now - DONE_WINDOW_MS) : []),
    [tab, projects, archives, scope, showOlder, now]
  )

  const [scopeMenu, setScopeMenu] = useState<MenuAnchor | null>(null)
  const [snooze, setSnooze] = useState<(DeskSnoozeRequest & { targets: readonly Target[] }) | null>(null)
  const closeSnooze = useCallback(() => setSnooze(null), [])
  const closeScopeMenu = useCallback(() => setScopeMenu(null), [])
  const hovered = useRef<string | null>(null)

  const pickScope = (next: DeskScope | null): void => {
    updateDesk({ scope: next })
    setScopeMenu(null)
    if (next) selectProjectHome(next.projectId)
  }

  const listed: InboxEntry[] = tab === 'inbox'
    ? [...lists.needsYou, ...lists.answered, ...lists.waiting]
    : tab === 'working' ? lists.working : tab === 'snoozed' ? lists.snoozed : []

  const openSnooze = (targets: readonly Target[], at: MenuAnchor): void => {
    if (targets.length > 0) setSnooze({ ...at, projectId: targets[0].projectId, taskId: targets[0].taskId, targets })
  }

  // Row keys: E done, S snooze, W wake, U unread, ⌫ remove — on the hovered row,
  // else the selected one. ⌥↓ / ⌥↑ walk the tab's rows; ⌘J goes to the next that needs you.
  const shown = shownRows(listed, grouped, [...pinnedIds])

  // Ticked rows for a bulk action. A switch of tab or scope starts over; a row
  // that leaves the tab (snoozed, landed) drops out of `ticked` by itself.
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  useEffect(() => { setChecked(new Set()); anchor.current = null }, [tab, scope?.projectId, scope?.streamId])
  const ticked = checkedRows(shown, checked)
  const checking = ticked.length > 0
  const clearChecked = useCallback(() => { setChecked(new Set()); anchor.current = null }, [])
  const check = (taskId: string, how: 'toggle' | 'range'): void => {
    const from = anchor.current ?? selectedTaskId
    setChecked(prev => checkRows(shown, prev, taskId, how, from))
    anchor.current = taskId
  }

  // The bulk loops call the newest Done / Remove: each task's turn sees the projects as the last one left them.
  const latest = useRef({ onDone, onRemove })
  latest.current = { onDone, onRemove }
  const bulk = {
    done: async (entries: readonly InboxEntry[]): Promise<void> => {
      clearChecked()
      // One at a time: tasks of one stream land into it in turn.
      for (const { project, task } of entries) await latest.current.onDone(project.id, task.id)
    },
    remove: async (entries: readonly InboxEntry[]): Promise<void> => {
      if (entries.length === 1) return onRemove(entries[0].project.id, entries[0].task.id)
      if (!window.confirm(`Remove ${entries.length} tasks and all their changes?\n\nWorktrees of their own are deleted with their branches, uncommitted work with them. Nothing is landed.`)) return
      clearChecked()
      for (const { project, task } of entries) await latest.current.onRemove(project.id, task.id, true)
    },
    wake: (entries: readonly InboxEntry[]): void => {
      for (const { project, task } of entries) if (isSnoozed(task, Date.now())) unsnoozeTask(project.id, task.id)
    },
    /** Any unread: all read. All read: all unread. */
    read: (entries: readonly InboxEntry[]): void => {
      const markRead = entries.some(entry => entry.unread)
      for (const { project, task } of entries) {
        if (markRead) markTaskVisited(project.id, task.id)
        else markTaskUnread(project.id, task.id)
      }
    },
    snoozeTargets: (entries: readonly InboxEntry[]): Target[] =>
      entries.filter(({ task }) => !isSnoozed(task, Date.now())).map(({ project, task }) => ({ projectId: project.id, taskId: task.id }))
  }

  const keyState = useRef({ listed: shown, selectedTaskId, tab, needsYou: lists.needsYou, ticked, bulk, snoozeOpen: snooze !== null })
  keyState.current = { listed: shown, selectedTaskId, tab, needsYou: lists.needsYou, ticked, bulk, snoozeOpen: snooze !== null }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A modal (Settings, a form, the bar) has the keys: E must not land the task behind it.
      if (e.defaultPrevented || document.querySelector('[data-modal]')) return
      // ⌘1–9: the row with that number (shown while ⌘ is held), from anywhere, a terminal included.
      const jump = !e.shiftKey && isTaskJumpKey(e) ? jumpDigit(e) : null
      if (jump !== null) {
        const entry = keyState.current.listed[jump]
        if (!entry) return
        e.preventDefault()
        onSelectTask(entry.project.id, entry.task.id)
        document.querySelector(`[data-testid="desk-row"][data-task-id="${entry.task.id}"]`)?.scrollIntoView({ block: 'nearest' })
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
        const next = nextNeedsYou(keyState.current.needsYou, keyState.current.selectedTaskId)
        if (!next) return
        e.preventDefault()
        onSelectTask(next.project.id, next.task.id)
        return
      }
      // ⌥↓ / ⌥↑ also work from an empty field: opening a task focuses its chat's composer.
      const field = e.target as HTMLTextAreaElement | HTMLInputElement | null
      const emptyField = !!field && (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') && !field.value
      if (typingTarget(e.target) && !emptyField) return
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const next = stepRow(keyState.current.listed, keyState.current.selectedTaskId, e.key === 'ArrowDown' ? 1 : -1)
        if (!next) return
        e.preventDefault()
        onSelectTask(next.project.id, next.task.id)
        document.querySelector(`[data-testid="desk-row"][data-task-id="${next.task.id}"]`)?.scrollIntoView({ block: 'nearest' })
        return
      }
      const { listed: rows, selectedTaskId: selected, ticked: tickedRows } = keyState.current
      if (typingTarget(e.target)) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && tickedRows.length > 0) {
        e.preventDefault()
        setChecked(new Set(rows.map(entry => entry.task.id)))
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape' && tickedRows.length > 0 && !keyState.current.snoozeOpen) {
        e.preventDefault()
        clearChecked()
        return
      }
      const key = e.key === 'Backspace' || e.key === 'Delete' ? 'remove' : e.key.toLowerCase()
      if (key === 'x') {
        const entry = keyTarget(rows, hovered.current, selected)
        if (!entry) return
        e.preventDefault()
        setChecked(prev => checkRows(rows, prev, entry.task.id, 'toggle', null))
        anchor.current = entry.task.id
        return
      }
      if (!['e', 's', 'w', 'u', 'remove'].includes(key)) return
      if (tickedRows.length > 0) {
        const { bulk: act } = keyState.current
        e.preventDefault()
        if (key === 'e') void act.done(tickedRows)
        else if (key === 'remove') void act.remove(tickedRows)
        else if (key === 'w') act.wake(tickedRows)
        else if (key === 'u') act.read(tickedRows)
        else if (key === 's') {
          const rect = document.querySelector('[data-testid="desk-bulk-bar"]')?.getBoundingClientRect()
          openSnooze(act.snoozeTargets(tickedRows), rect ? { x: rect.left + 12, y: rect.bottom + 4 } : { x: 200, y: 200 })
        }
        return
      }
      // ⌫ only acts on the row under the pointer: a stray Backspace must not close the open task.
      const entry = keyTarget(rows, hovered.current, key === 'remove' ? null : selected)
      if (!entry) return
      const { project, task } = entry
      e.preventDefault()
      if (key === 'e') void onDone(project.id, task.id)
      else if (key === 'remove') void onRemove(project.id, task.id)
      else if (key === 's' && !isSnoozed(task, Date.now())) {
        const row = document.querySelector(`[data-testid="desk-row"][data-task-id="${task.id}"]`)
        const rect = row?.getBoundingClientRect()
        openSnooze([{ projectId: project.id, taskId: task.id }], rect ? { x: rect.right - 240, y: rect.top + 32 } : { x: 200, y: 200 })
      } else if (key === 'w' && isSnoozed(task, Date.now())) unsnoozeTask(project.id, task.id)
      else if (key === 'u') {
        if (entry.unread) markTaskVisited(project.id, task.id)
        else markTaskUnread(project.id, task.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone, onRemove, onSelectTask, unsnoozeTask, markTaskUnread, markTaskVisited, clearChecked])

  const jumpIndex = new Map(shown.slice(0, 9).map((entry, i) => [entry.task.id, i + 1]))
  const renderRow = (entry: InboxEntry, kind: DeskRowKind): React.ReactElement => {
    const background = kind === 'working' ? taskBackground(entry.task, activities) : null
    return (
      <DeskRow
        key={entry.task.id}
        entry={entry}
        kind={kind}
        agent={taskActivity(entry.task, allStatuses, activities)}
        activity={bestActivity(entry, activities)}
        background={background}
        diff={kind === 'snoozed' ? undefined : diffs.get(entry.task.id)}
        onStopBackground={background && background.tasks.length > 0 ? () => { void stopBackground(background) } : undefined}
        selected={selectedTaskId === entry.task.id}
        jumpNumber={jumpIndex.get(entry.task.id)}
        checked={checked.has(entry.task.id)}
        checking={checking}
        pinned={pinnedTaskIds.has(entry.task.id)}
        offline={offlineIds.has(entry.project.id)}
        showTile={showTiles}
        now={now}
        theme={effectiveTheme}
        onSelect={(e) => {
          if (e.metaKey || e.ctrlKey) return check(entry.task.id, 'toggle')
          if (e.shiftKey) return check(entry.task.id, 'range')
          clearChecked()
          anchor.current = entry.task.id
          onSelectTask(entry.project.id, entry.task.id)
        }}
        onCheck={() => check(entry.task.id, 'toggle')}
        onScopeProject={(project) => pickScope({ projectId: project.id })}
        onContextMenu={(e) => { e.preventDefault(); onTaskContextMenu(e, entry.project.id, entry.task.id) }}
        onDone={() => void onDone(entry.project.id, entry.task.id)}
        onSnooze={(e) => { const r = e.currentTarget.getBoundingClientRect(); openSnooze([{ projectId: entry.project.id, taskId: entry.task.id }], { x: r.left, y: r.bottom + 4 }) }}
        onWake={() => unsnoozeTask(entry.project.id, entry.task.id)}
        onHover={(id) => { hovered.current = id }}
        rename={rename?.taskId === entry.task.id ? rename : undefined}
      />
    )
  }

  // A click on blank sidebar space lets go of the open task and puts the caret in
  // compose: the next keys are a new task, not E / S on the task you were reading.
  const onBlankClick = (e: React.MouseEvent<HTMLElement>): void => {
    const el = e.target as HTMLElement
    // Menus are React children but not in the column's DOM; their clicks bubble here too.
    if (!e.currentTarget.contains(el)) return
    if (el.closest('button, a, input, textarea, select, label, [role="menu"], [role="tab"], [contenteditable="true"], [data-testid="desk-row"], [data-testid="desk-done-row"], [data-testid="desk-compose"]')) return
    if (window.getSelection()?.toString()) return
    if (selectedTaskId) setSelectedProjectId(null)
    clearChecked()
    deskEvents.focusCompose()
  }

  const empty = (text: string): React.ReactElement => (
    <div className="px-6 py-10 text-center text-sm text-text-muted" data-testid="desk-empty">{text}</div>
  )

  return (
    <nav
      aria-label="Inbox"
      className="desk-column relative flex flex-col shrink-0 min-h-0 bg-surface border-r border-hair select-none"
      style={{ width, minWidth: width, maxWidth: width }}
      onClick={onBlankClick}
      data-testid="desk-column"
    >
      {/* Title bar: traffic lights sit on the left, so the controls start past them. */}
      <div className="h-11 shrink-0 flex items-center gap-2 pl-[78px] pr-3 border-b border-hair [-webkit-app-region:drag]">
        <button
          type="button"
          className="flex items-center gap-1 min-w-0 px-2 py-1 rounded-md bg-transparent border-0 text-sm text-text cursor-pointer hover:bg-surface-3 [-webkit-app-region:no-drag]"
          onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setScopeMenu(scopeMenu ? null : { x: r.left, y: r.bottom + 4 }) }}
          onMouseDown={(e) => e.stopPropagation()}
          data-testid="desk-scope"
        >
          {scope && showTiles && (() => {
            const project = projects.find(p => p.id === scope.projectId)
            return project ? <ProjectTileBadge project={project} theme={effectiveTheme} size={14} /> : null
          })()}
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{scopeLabel(projects, scope)}</span>
          <ChevronDown size={12} className="text-text-subtle shrink-0" />
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-row-hover border border-border text-sm text-text-muted cursor-pointer hover:text-text [-webkit-app-region:no-drag]"
          onClick={() => paletteEvents.emit('palette-prefix-set', '')}
          title="Jump, run a command or start a task"
        >
          <Search size={13} />
          <span className="font-mono text-xs border border-line rounded px-1.5">{formatShortcutForApp('CmdOrCtrl+K')}</span>
        </button>
      </div>

      <div className="px-4 pt-3.5 pb-2.5 flex flex-col gap-2.5 border-b border-hair">
        {config && (
          <DeskCompose projects={composeProjects} scope={scope} config={config} theme={effectiveTheme} onCompose={onCompose} />
        )}
        {checking ? (
          <BulkBar
            entries={ticked}
            total={shown.length}
            onDone={() => void bulk.done(ticked)}
            onSnooze={(e) => { const r = e.currentTarget.getBoundingClientRect(); openSnooze(bulk.snoozeTargets(ticked), { x: r.left, y: r.bottom + 4 }) }}
            onWake={() => bulk.wake(ticked)}
            onRead={() => bulk.read(ticked)}
            onRemove={() => void bulk.remove(ticked)}
            onAll={() => setChecked(new Set(shown.map(entry => entry.task.id)))}
            onClear={clearChecked}
          />
        ) : <div className="flex gap-1 items-center" role="tablist">
          {TABS.map(({ id, label }) => {
            const active = tab === id
            const count = counts[id]
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                className={[
                  'rounded-full px-2.5 py-[3px] text-sm border cursor-pointer',
                  active ? 'bg-border border-border-strong text-text font-semibold' : 'bg-transparent border-transparent text-text-muted hover:text-text'
                ].join(' ')}
                onClick={() => updateDesk({ tab: id })}
                data-testid={`desk-tab-${id}`}
              >
                {label}{count ? <span className="ml-1 tabular-nums">{count}</span> : null}
              </button>
            )
          })}
          <span className="flex-1" />
          <button
            type="button"
            className="flex items-center p-1 rounded-md bg-transparent border-0 text-text-muted cursor-pointer hover:text-text hover:bg-surface-3"
            onClick={() => updateConfig({ inboxLayout: grouped ? 'flat' : 'grouped' })}
            title={grouped ? 'Group by status' : 'Group by project'}
            aria-pressed={grouped}
            data-testid="desk-group-toggle"
          >{grouped ? <List size={14} /> : <Folders size={14} />}</button>
        </div>}
      </div>

      <div className="flex-1 overflow-y-auto pb-2" data-testid="desk-list">
        {grouped && tab !== 'done' && (listed.length === 0
          ? empty(tab === 'inbox' ? (scope ? 'Nothing here. Ask something above.' : 'Inbox zero. Ask something above.') : tab === 'working' ? 'No agent is working.' : 'Nothing snoozed.')
          : groupInboxByProject(listed, [...pinnedIds]).map(group => (
            <React.Fragment key={group.project.id}>
              <ProjectGroupHead project={group.project} count={group.entries.length} theme={effectiveTheme} showTile={showTiles} onScope={() => pickScope({ projectId: group.project.id })} />
              {group.entries.map(entry => renderRow(entry, tab === 'inbox' ? inboxKind(lists, entry) : tab === 'working' ? 'working' : 'snoozed'))}
            </React.Fragment>
          )))}
        {!grouped && tab === 'inbox' && (
          lists.needsYou.length + lists.answered.length + lists.waiting.length === 0
            ? empty(scope ? 'Nothing here. Ask something above.' : 'Inbox zero. Ask something above.')
            : <>
              {lists.needsYou.length > 0 && <GroupHead label="Needs you" count={lists.needsYou.length} tone="needs" />}
              {lists.needsYou.map(entry => renderRow(entry, 'needsYou'))}
              {lists.answered.length > 0 && <GroupHead label="Answered" count={lists.answered.length} tone="answered" hint="E done · S snooze" />}
              {lists.answered.map(entry => renderRow(entry, 'answered'))}
              {lists.waiting.length > 0 && <GroupHead label="Waiting on you" count={lists.waiting.length} />}
              {lists.waiting.map(entry => renderRow(entry, 'waiting'))}
            </>
        )}
        {!grouped && tab === 'working' && (lists.working.length === 0 ? empty('No agent is working.') : lists.working.map(entry => renderRow(entry, 'working')))}
        {!grouped && tab === 'snoozed' && (lists.snoozed.length === 0 ? empty('Nothing snoozed.') : lists.snoozed.map(entry => renderRow(entry, 'snoozed')))}
        {tab === 'done' && (
          <DoneList
            entries={done}
            loading={archiveIds.some(id => !archives.has(id))}
            now={now}
            theme={effectiveTheme}
            showTiles={showTiles}
            showingOlder={showOlder}
            onShowOlder={() => setShowOlder(true)}
            onOpen={(entry) => showArchived({ projectId: entry.project.id, kind: 'task', id: entry.entry.task.id })}
            onReopen={(entry) => void reopenTask(entry.project.id, entry.entry.task.id)}
          />
        )}
      </div>

      <DeskScopeMenu
        anchor={scopeMenu}
        projects={composeProjects}
        pinnedIds={pinnedIds}
        pinnedStreams={pinnedStreams}
        missingDirIds={missingDirIds}
        scope={scope}
        theme={effectiveTheme}
        onPick={pickScope}
        footer={footer}
        onClose={closeScopeMenu}
      />
      <DeskSnoozeMenu
        request={snooze}
        onSnooze={(_projectId, _taskId, options) => {
          for (const target of snooze?.targets ?? []) snoozeTask(target.projectId, target.taskId, options)
          if ((snooze?.targets.length ?? 0) > 1) clearChecked()
        }}
        onClose={closeSnooze}
      />

      <div
        className="absolute right-0 top-0 bottom-0 w-[3px] cursor-col-resize hover:bg-border-strong active:bg-border-strong transition-colors duration-(--motion-fast) [-webkit-app-region:no-drag]"
        onMouseDown={resize.onMouseDown}
      />
    </nav>
  )
}

function DoneList({ entries, loading, now, theme, showTiles, showingOlder, onShowOlder, onOpen, onReopen }: {
  entries: DoneEntry[]
  loading: boolean
  now: number
  theme: 'dark' | 'light'
  showTiles: boolean
  showingOlder: boolean
  onShowOlder: () => void
  onOpen: (entry: DoneEntry) => void
  onReopen: (entry: DoneEntry) => void
}): React.ReactElement {
  if (entries.length === 0) {
    return <div className="px-6 py-10 text-center text-sm text-text-muted">{loading ? 'Loading…' : 'Nothing done in the last 30 days.'}</div>
  }
  return (
    <>
      {entries.map((item) => {
        const { project, entry } = item
        return (
          <div
            key={entry.task.id}
            className="group relative flex gap-3 mx-2 px-3 py-2.5 rounded-[9px] items-start cursor-pointer hover:bg-row-hover"
            onClick={() => onOpen(item)}
            data-testid="desk-done-row"
          >
            {showTiles && <ProjectTileBadge project={project} theme={theme} size={24} />}
            <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
              <div className="flex justify-between gap-2 text-xs text-text-muted">
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  <strong className="font-semibold text-body">{project.name}</strong>
                  {entry.streamName && entry.streamName !== 'main' && <> › <span className="font-mono">{entry.streamName}</span></>}
                </span>
                <span className="tabular-nums group-hover:invisible">{entry.archivedAt ? formatRelativeAge(now - entry.archivedAt) : ''}</span>
              </div>
              <span className="flex items-baseline gap-1.5 min-w-0">
                <span className="text-base text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">{entry.task.name}</span>
                {autopilotLanded(entry.task) && <AutopilotMark />}
              </span>
            </div>
            <div className="absolute right-2.5 top-2 hidden group-hover:flex gap-1 pl-2 bg-row-hover" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="px-2 py-1 rounded-md border-0 bg-border text-sm text-text cursor-pointer hover:bg-border-strong" onClick={() => onReopen(item)}>Reopen</button>
            </div>
          </div>
        )
      })}
      {!showingOlder && (
        <button type="button" className="mx-auto mt-2 block px-3 py-1 rounded-md border-0 bg-transparent text-sm text-text-muted cursor-pointer hover:text-text" onClick={onShowOlder}>Show older</button>
      )}
    </>
  )
}

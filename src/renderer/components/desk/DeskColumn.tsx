import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import type { DeskScope, DeskTab, Project } from '../../../shared/types'
import { useApp } from '../../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince } from '../../context/TabStatusContext'
import { useAllAgentActivity } from '../../agentActivity'
import { useProjectArchives } from '../../hooks/archiveStore'
import { useResizeHandle } from '../../hooks/useResizeHandle'
import { paletteEvents } from '../../palette/paletteEvents'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import type { MenuAnchor } from '../../hooks/useMenuPosition'
import ProjectTileBadge from '../ProjectTileBadge'
import { formatRelativeAge, inboxSources, isSnoozed, partitionInbox, taskActivity, type InboxEntry } from '../inbox'
import type { InboxRename } from '../InboxPanel'
import type { NewTaskSubmission } from '../newTask'
import DeskCompose from './DeskCompose'
import DeskRow, { bestActivity, type DeskRowKind } from './DeskRow'
import DeskScopeMenu from './DeskScopeMenu'
import DeskSnoozeMenu, { type DeskSnoozeRequest } from './DeskSnoozeMenu'
import { DONE_WINDOW_MS, deskLists, deskTabCounts, doneEntries, keyTarget, scopeLabel, scopeSources, type DoneEntry } from './deskInbox'

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

/**
 * The desk layout's left column (redesign step 1): scope menu and the bar
 * button, the compose box, the Inbox / Working / Snoozed / Done tabs and the
 * mail-style list. Rows offer ✓ Done (E) and Snooze (S); W wakes and U marks
 * unread. The modals (Settings, New project, the row menu) stay with the Sidebar
 * that hosts this column.
 */
export default function DeskColumn({
  projects, composeProjects, pinnedIds, missingDirIds, onSelectTask, onTaskContextMenu, onDone, onCompose, footer, rename
}: {
  /** Every project with tasks the column may list, ad-hoc ones included. */
  projects: readonly Project[]
  /** Where compose and the scope menu may aim: the projects you added. */
  composeProjects: readonly Project[]
  pinnedIds: ReadonlySet<string>
  missingDirIds: ReadonlySet<string>
  onSelectTask: (projectId: string, taskId: string) => void
  onTaskContextMenu: (e: React.MouseEvent, projectId: string, taskId: string) => void
  onDone: (projectId: string, taskId: string) => void
  onCompose: (submission: NewTaskSubmission) => void
  footer: ReadonlyArray<{ label: string; onClick: () => void }>
  rename: InboxRename | null
}): React.ReactElement {
  const {
    config, desk, updateDesk, selectedTaskId, selectProjectHome, effectiveTheme,
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
  const scope: DeskScope | null = desk.scope ?? null

  const lists = useMemo(
    () => deskLists(partitionInbox(scopeSources(inboxSources([...projects]), scope), allStatuses, statusSince, now)),
    [projects, scope, allStatuses, statusSince, now]
  )
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
  const [snooze, setSnooze] = useState<DeskSnoozeRequest | null>(null)
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

  const openSnooze = (projectId: string, taskId: string, at: MenuAnchor): void => setSnooze({ ...at, projectId, taskId })

  // Row keys: E done, S snooze, W wake, U unread — on the hovered row, else the selected one.
  const keyState = useRef({ listed, selectedTaskId, tab })
  keyState.current = { listed, selectedTaskId, tab }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || typingTarget(e.target)) return
      const key = e.key.toLowerCase()
      if (!['e', 's', 'w', 'u'].includes(key)) return
      const { listed: rows, selectedTaskId: selected } = keyState.current
      const entry = keyTarget(rows, hovered.current, selected)
      if (!entry) return
      const { project, task } = entry
      e.preventDefault()
      if (key === 'e') onDone(project.id, task.id)
      else if (key === 's' && !isSnoozed(task, Date.now())) {
        const row = document.querySelector(`[data-testid="desk-row"][data-task-id="${task.id}"]`)
        const rect = row?.getBoundingClientRect()
        openSnooze(project.id, task.id, rect ? { x: rect.right - 240, y: rect.top + 32 } : { x: 200, y: 200 })
      } else if (key === 'w' && isSnoozed(task, Date.now())) unsnoozeTask(project.id, task.id)
      else if (key === 'u') {
        if (entry.unread) markTaskVisited(project.id, task.id)
        else markTaskUnread(project.id, task.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone, unsnoozeTask, markTaskUnread, markTaskVisited])

  const renderRow = (entry: InboxEntry, kind: DeskRowKind): React.ReactElement => (
    <DeskRow
      key={entry.task.id}
      entry={entry}
      kind={kind}
      agent={taskActivity(entry.task, allStatuses, activities)}
      activity={bestActivity(entry, activities)}
      selected={selectedTaskId === entry.task.id}
      now={now}
      theme={effectiveTheme}
      onSelect={() => onSelectTask(entry.project.id, entry.task.id)}
      onScopeProject={(project) => pickScope({ projectId: project.id })}
      onContextMenu={(e) => { e.preventDefault(); onTaskContextMenu(e, entry.project.id, entry.task.id) }}
      onDone={() => onDone(entry.project.id, entry.task.id)}
      onSnooze={(e) => { const r = e.currentTarget.getBoundingClientRect(); openSnooze(entry.project.id, entry.task.id, { x: r.left, y: r.bottom + 4 }) }}
      onWake={() => unsnoozeTask(entry.project.id, entry.task.id)}
      onHover={(id) => { hovered.current = id }}
      rename={rename?.taskId === entry.task.id ? rename : undefined}
    />
  )

  const empty = (text: string): React.ReactElement => (
    <div className="px-6 py-10 text-center text-sm text-text-muted" data-testid="desk-empty">{text}</div>
  )

  return (
    <nav
      aria-label="Inbox"
      className="desk-column relative flex flex-col shrink-0 min-h-0 bg-surface border-r border-hair select-none"
      style={{ width, minWidth: width, maxWidth: width }}
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
          {scope && (() => {
            const project = projects.find(p => p.id === scope.projectId)
            return project ? <ProjectTileBadge project={project} theme={effectiveTheme} size={14} /> : null
          })()}
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{scopeLabel(projects, scope)}</span>
          <ChevronDown size={12} className="text-text-subtle shrink-0" />
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[#1a1b1f] border border-border text-sm text-text-muted cursor-pointer hover:text-text [-webkit-app-region:no-drag]"
          onClick={() => paletteEvents.emit('palette-prefix-set', '')}
          title="Jump to a task, project or command"
        >
          <Search size={13} />
          <span className="font-mono text-xs border border-[#2f3237] rounded px-1.5">{formatShortcutForApp('CmdOrCtrl+K')}</span>
        </button>
      </div>

      <div className="px-4 pt-3.5 pb-2.5 flex flex-col gap-2.5 border-b border-hair">
        {config && (
          <DeskCompose projects={composeProjects} scope={scope} config={config} theme={effectiveTheme} onCompose={onCompose} />
        )}
        <div className="flex gap-1 items-center" role="tablist">
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
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-2" data-testid="desk-list">
        {tab === 'inbox' && (
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
        {tab === 'working' && (lists.working.length === 0 ? empty('No agent is working.') : lists.working.map(entry => renderRow(entry, 'working')))}
        {tab === 'snoozed' && (lists.snoozed.length === 0 ? empty('Nothing snoozed.') : lists.snoozed.map(entry => renderRow(entry, 'snoozed')))}
        {tab === 'done' && (
          <DoneList
            entries={done}
            loading={archiveIds.some(id => !archives.has(id))}
            now={now}
            theme={effectiveTheme}
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
        missingDirIds={missingDirIds}
        scope={scope}
        theme={effectiveTheme}
        onPick={pickScope}
        footer={footer}
        onClose={closeScopeMenu}
      />
      <DeskSnoozeMenu
        request={snooze}
        onSnooze={(projectId, taskId, options) => snoozeTask(projectId, taskId, options)}
        onClose={closeSnooze}
      />

      <div
        className="absolute right-0 top-0 bottom-0 w-[3px] cursor-col-resize hover:bg-border-strong active:bg-border-strong transition-colors duration-(--motion-fast) [-webkit-app-region:no-drag]"
        onMouseDown={resize.onMouseDown}
      />
    </nav>
  )
}

function DoneList({ entries, loading, now, theme, showingOlder, onShowOlder, onOpen, onReopen }: {
  entries: DoneEntry[]
  loading: boolean
  now: number
  theme: 'dark' | 'light'
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
            className="group relative flex gap-3 mx-2 px-3 py-2.5 rounded-[9px] items-start cursor-pointer hover:bg-[#1a1b1f]"
            onClick={() => onOpen(item)}
            data-testid="desk-done-row"
          >
            <ProjectTileBadge project={project} theme={theme} size={24} />
            <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
              <div className="flex justify-between gap-2 text-xs text-text-muted">
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  <strong className="font-semibold text-[#d6d6d8]">{project.name}</strong>
                  {entry.streamName && entry.streamName !== 'main' && <> › <span className="font-mono">{entry.streamName}</span></>}
                </span>
                <span className="tabular-nums group-hover:invisible">{entry.archivedAt ? formatRelativeAge(now - entry.archivedAt) : ''}</span>
              </div>
              <span className="text-base text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">{entry.task.name}</span>
            </div>
            <div className="absolute right-2.5 top-2 hidden group-hover:flex gap-1 pl-2 bg-[#1a1b1f]" onClick={(e) => e.stopPropagation()}>
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

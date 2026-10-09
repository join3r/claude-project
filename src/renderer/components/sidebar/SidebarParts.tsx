/** Small presentational pieces and status helpers shared by the sidebar tree. */
import React, { useState } from 'react'
import type { Project, Task } from '../../../shared/types'
import { landingStatusLabel } from '../../../shared/inbox-state'
import { useLandingOp, useStreamAhead } from '../../taskLanding'
import { projectSwatch, projectTile } from '../../../shared/project-label'
import { dashboardIconUrl, type DashboardIconsMetadata } from '../dashboardIcons'
import type { SidebarTaskState, TaskDropSlot } from './streamTree'

export type SidebarContextMenuState = {
  x: number; y: number; type: 'project' | 'stream' | 'task'; projectId: string; streamId?: string; taskId?: string
}

export type DragState = {
  type: 'project' | 'task'
  id: string
  /** A project's place in `projectOrder`; a task's place in its stream. */
  index: number
  projectId?: string
  streamId?: string
}

export type DropTarget =
  | { type: 'between-projects'; index: number }
  | ({ type: 'task-slot'; projectId: string } & TaskDropSlot)
  | null

/** Rows carry mx-1.5 (6px) and px-2.5 (10px), so a project's chevron sits 16px
    from the sidebar edge. Each level steps in 18px (chevron 10 + gap 8): a
    stream's chevron sits under the project name, a task's dot under the stream
    name. Rows indent with pl (inside mx), drop indicators with ml (no mx). */
export const STREAM_ROW_PL = 'pl-[28px]'
export const TASK_ROW_PL = 'pl-[46px]'
export const TASK_ROW_ML = 'ml-[52px]'
/** Rows inside a stream's Done group: one step past the task rows. */
export const DONE_ITEM_PL = 'pl-[64px]'

/** The tree's fold marker: a small filled triangle, quieter than an icon. */
export function TreeChevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 10 10"
      className={`w-2.5 h-2.5 shrink-0 text-text-subtle transition-transform duration-(--motion-fast) ${open ? 'rotate-90' : ''}`}
      aria-hidden
    >
      <path d="M3.5 2.5 7 5 3.5 7.5Z" fill="currentColor" />
    </svg>
  )
}

/** Icon buttons in the sidebar header strip (search / filter / add). */
export const headerIconCls = 'relative flex items-center bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md hover:bg-surface-3 hover:text-text transition-colors duration-(--motion-fast)'

/** The project's icon or tile; nothing when Settings → Show project icons is off. */
export function ProjectIconSlot({
  project,
  theme,
  metadata,
  show,
}: {
  project: Project
  theme: 'dark' | 'light'
  metadata: DashboardIconsMetadata | null
  show: boolean
}): React.ReactElement | null {
  if (!show) return null
  return <ProjectIcon project={project} theme={theme} metadata={metadata} />
}

function ProjectIcon({
  project,
  theme,
  metadata,
}: {
  project: Project
  theme: 'dark' | 'light'
  metadata: DashboardIconsMetadata | null
}): React.ReactElement {
  const [iconFailed, setIconFailed] = useState(false)
  const iconUrl = project.icon && !iconFailed
    ? dashboardIconUrl(project.icon, { theme, metadata: metadata ?? undefined })
    : null
  const tile = projectTile(project)
  const swatch = projectSwatch(tile, theme)

  return (
    <span className="w-5 shrink-0 flex items-center justify-center">
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className="w-3.5 h-3.5 object-contain"
          onError={() => setIconFailed(true)}
        />
      ) : tile.emoji ? (
        <span className="text-base leading-none">{tile.emoji}</span>
      ) : (
        <span
          className="w-4 h-4 rounded-sm text-[8px] font-semibold leading-none flex items-center justify-center"
          style={{ backgroundColor: swatch.bg, color: swatch.fg }}
          title={project.name}
        >
          {tile.text}
        </span>
      )}
    </span>
  )
}

/** One of the Projects | Inbox pills in the sidebar header. */
export function SidebarTabButton({
  label,
  active,
  badge,
  onClick
}: {
  label: string
  active: boolean
  badge?: number
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'flex items-center gap-1.5 border-0 px-2 py-1 rounded-md cursor-pointer text-sm',
        'transition-colors duration-(--motion-fast)',
        active ? 'bg-surface-3 text-text' : 'bg-transparent text-text-muted hover:text-text'
      ].join(' ')}
    >
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="px-1.5 rounded-full bg-accent text-2xs font-semibold text-accent-ink leading-[1.4] tabular-nums">
          {badge}
        </span>
      )}
    </button>
  )
}

const STATE_DOT_CLS: Record<Exclude<SidebarTaskState, null>, string> = {
  attention: 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]',
  working: 'bg-status-working status-pulse',
  unread: 'bg-info',
  exited: 'bg-status-exited'
}

const STATE_LABEL: Record<Exclude<SidebarTaskState, null>, string> = {
  attention: 'Needs you',
  working: 'Working',
  unread: 'Unread',
  exited: 'Exited'
}

/**
 * A task's state dot, or a stream's / project's rolled-up one. `hollow` keeps an
 * empty slot for a quiet task so the row's dot column stays aligned; `hideOnHover`
 * makes room for the row's hover actions.
 */
export function StateDot({ state, hollow, hideOnHover }: {
  state: SidebarTaskState
  hollow?: boolean
  hideOnHover?: boolean
}): React.ReactElement | null {
  if (!state && !hollow) return null
  const cls = state ? STATE_DOT_CLS[state] : ''
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls} ${hideOnHover ? 'group-hover:hidden' : ''}`}
      title={state ? STATE_LABEL[state] : undefined}
    />
  )
}

const LANDING_BADGE: Record<NonNullable<Task['landing']>['state'], { label: string; cls: string }> = {
  landing: { label: 'landing…', cls: 'text-text-subtle' },
  fixing: { label: 'fixing…', cls: 'text-info' },
  conflict: { label: 'conflict', cls: 'text-danger' },
  blocked: { label: 'blocked', cls: 'text-warn' }
}

/**
 * A task row's landing badges: where its landing into the stream stands
 * (`Task.landing`, or a call this window is still waiting on), and
 * "<stream> +N" when the stream has commits the task's branch doesn't.
 */
export function LandingBadges({ task, streamName }: { task: Task; streamName: string }): React.ReactElement | null {
  const op = useLandingOp(task.id)
  const ahead = useStreamAhead(task.id)
  const state = task.landing?.state ?? (op === 'close' || op === 'land' || op === 'update' ? 'landing' : undefined)
  const showAhead = !!task.workspace && !!ahead
  if (!state && !showAhead) return null
  const badge = state ? LANDING_BADGE[state] : null
  return (
    <>
      {badge && (
        <span
          className={`text-2xs shrink-0 ${badge.cls}`}
          title={landingStatusLabel(task.landing, streamName) ?? undefined}
          data-testid="task-landing-badge"
        >
          {badge.label}
        </span>
      )}
      {showAhead && (
        <span
          className="text-2xs font-mono text-text-subtle min-w-0 shrink-[4] max-w-[96px] overflow-hidden text-ellipsis whitespace-nowrap"
          title={`${streamName} has ${ahead === 1 ? '1 commit' : `${ahead} commits`} this task doesn't`}
          data-testid="task-stream-ahead"
        >
          {streamName} +{ahead}
        </span>
      )}
    </>
  )
}

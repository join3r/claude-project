/** Small presentational pieces and status helpers shared by the sidebar tree. */
import React, { useState } from 'react'
import type { Project } from '../../../shared/types'
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

/** Rows carry mx-1.5 (6px); project name starts 64px from the sidebar edge:
    6 (mx) + 10 (px-2.5) + 12 (chevron) + 8 (gap) + 20 (icon) + 8 (gap).
    A stream row's chevron sits under the project icon, so its name lines up
    with the project name; a task row's dot sits there too, its name one step in.
    Rows indent with pl (inside mx), drop indicators with ml (no mx). */
export const STREAM_ROW_PL = 'pl-[38px]'
export const TASK_ROW_PL = 'pl-[58px]'
export const TASK_ROW_ML = 'ml-[64px]'

/** Icon buttons in the sidebar header strip (search / filter / add). */
export const headerIconCls = 'relative flex items-center bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md hover:bg-surface-3 hover:text-text transition-colors duration-(--motion-fast)'

export function getProjectInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const words = trimmed.split(/[\s\-_/]+/).filter(Boolean)
  if (words.length >= 2) {
    const a = words[0]?.replace(/[^a-zA-Z0-9]/g, '')[0]
    const b = words[1]?.replace(/[^a-zA-Z0-9]/g, '')[0]
    if (a && b) return (a + b).toUpperCase()
  }
  const letters = (words[0] ?? trimmed).replace(/[^a-zA-Z0-9]/g, '')
  if (!letters) return '?'
  return letters.slice(0, 2).toUpperCase()
}

export function ProjectIconSlot({
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

  return (
    <span className="w-5 shrink-0 flex items-center justify-center">
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className="w-3.5 h-3.5 object-contain"
          onError={() => setIconFailed(true)}
        />
      ) : project.emoji ? (
        <span className="text-base leading-none">{project.emoji}</span>
      ) : (
        <span
          className="w-3.5 h-3.5 rounded-sm bg-surface-3 text-text-muted text-[8px] font-semibold leading-none flex items-center justify-center"
          title={project.name}
        >
          {getProjectInitials(project.name)}
        </span>
      )}
    </span>
  )
}

/** One half of the Projects | Inbox segmented control in the sidebar header. */
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
      className={[
        'flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer',
        'text-2xs font-bold uppercase tracking-[0.06em]',
        'transition-colors duration-(--motion-fast)',
        active ? 'text-text' : 'text-text-subtle hover:text-text-muted'
      ].join(' ')}
    >
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="px-1 rounded-full bg-status-attention text-2xs font-bold text-accent-ink leading-[1.4] tabular-nums">
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
 * A task's state dot, or a stream's / project's rolled-up one. `hollow` draws a
 * quiet task as a ring so the row's dot column stays aligned; `hideOnHover`
 * makes room for the row's hover actions.
 */
export function StateDot({ state, hollow, hideOnHover }: {
  state: SidebarTaskState
  hollow?: boolean
  hideOnHover?: boolean
}): React.ReactElement | null {
  if (!state && !hollow) return null
  const cls = state ? STATE_DOT_CLS[state] : 'border border-border-strong'
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${cls} ${hideOnHover ? 'group-hover:hidden' : ''}`}
      title={state ? STATE_LABEL[state] : undefined}
    />
  )
}

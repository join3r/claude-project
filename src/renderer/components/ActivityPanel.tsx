import React, { useState, useRef, useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Project, AppConfig } from '../../shared/types'
import { AI_TAB_TYPES, isHomeTask, isWorkspaceTask } from '../../shared/types'
import type { TabStatusValue } from '../context/TabStatusContext'
import { buildRecencyStyle, computeTaskRecencyOpacity, sortTasksByRecency } from './taskRecency'

type Props = {
  projects: Project[]
  selectedTaskId: string | null
  switchToTask: (projectId: string, taskId: string) => void
  onTaskContextMenu: (e: React.MouseEvent, projectId: string, taskId: string) => void
  recencySettings: AppConfig['taskRecencyHighlight']
  now: number
  heightPx: number
  onHeightChange: (next: number) => void
  allStatuses: Record<string, TabStatusValue>
  theme: 'dark' | 'light'
}

function getTaskStatus(
  task: { tabs: { left: { id: string; type: string }[]; right: { id: string; type: string }[] } },
  allStatuses: Record<string, TabStatusValue>
): TabStatusValue {
  const aiTabIds = [...task.tabs.left, ...task.tabs.right]
    .filter((t) => (AI_TAB_TYPES as readonly string[]).includes(t.type))
    .map((t) => t.id)
  if (aiTabIds.length === 0) return null
  const statuses = aiTabIds.map((id) => allStatuses[id]).filter(Boolean)
  if (statuses.includes('attention')) return 'attention'
  if (statuses.includes('working')) return 'working'
  if (statuses.includes('exited')) return 'exited'
  return null
}

function StatusDot({ status }: { status: NonNullable<TabStatusValue> }) {
  const stateClass =
    status === 'working'
      ? 'bg-status-working animate-pulse'
      : status === 'attention'
        ? 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
        : 'bg-status-exited'
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-auto ${stateClass}`} />
}

export default function ActivityPanel({
  projects,
  selectedTaskId,
  switchToTask,
  onTaskContextMenu,
  recencySettings,
  now,
  heightPx,
  onHeightChange,
  allStatuses,
  theme
}: Props): React.ReactElement {
  const collapsed = heightPx === 0
  const panelRef = useRef<HTMLDivElement>(null)
  const [lastExpandedHeight, setLastExpandedHeight] = useState<number>(() => heightPx > 0 ? heightPx : 160)

  const sortedByRecency = React.useMemo(
    () => sortTasksByRecency(projects.flatMap(p => p.tasks.filter(t => !isHomeTask(t)))),
    [projects]
  )

  const projectByTaskId = React.useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of projects) {
      for (const task of project.tasks.filter(t => !isHomeTask(t))) {
        map.set(task.id, project)
      }
    }
    return map
  }, [projects])

  const toggleCollapse = () => {
    if (collapsed) {
      onHeightChange(lastExpandedHeight > 0 ? lastExpandedHeight : 160)
    } else {
      setLastExpandedHeight(heightPx)
      onHeightChange(0)
    }
  }

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startY = e.clientY
    const startHeight = heightPx > 0 ? heightPx : 160

    const onMove = (ev: MouseEvent) => {
      const next = startHeight + (startY - ev.clientY)
      const sidebar = panelRef.current?.closest('.sidebar') as HTMLElement | null
      const maxAllowed = sidebar ? Math.max(60, sidebar.clientHeight - 120) : next
      const clamped = Math.min(maxAllowed, Math.max(60, next))
      onHeightChange(clamped)
      setLastExpandedHeight(clamped)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'ns-resize'
  }, [heightPx, onHeightChange])

  const panelStyle: React.CSSProperties = collapsed
    ? { height: 'auto' }
    : { height: `${heightPx}px` }

  return (
    <>
      {!collapsed && (
        <div
          className="h-1 cursor-ns-resize bg-transparent shrink-0 hover:bg-border-focus"
          onMouseDown={handleSplitterMouseDown}
        />
      )}
      <div
        className="border-t border-hair flex flex-col shrink-0 overflow-hidden"
        style={panelStyle}
        ref={panelRef}
      >
        <div
          className="flex items-center px-3 py-1.5 text-2xs font-bold uppercase tracking-[0.06em] text-text-muted cursor-pointer shrink-0 hover:text-text transition-colors duration-(--motion-fast)"
          onClick={toggleCollapse}
        >
          <ChevronRight size={12} className={`mr-1.5 transition-transform duration-(--motion-fast) ${collapsed ? '' : 'rotate-90'}`} />
          Recent{collapsed ? ` (${sortedByRecency.length})` : ''}
        </div>
        {!collapsed && (
          <div className="overflow-y-auto flex-1 min-h-0 pt-0.5 pb-1">
            {sortedByRecency.length === 0 ? (
              <div className="p-3 text-text-muted text-sm italic text-center">No recent activity</div>
            ) : (
              sortedByRecency.map(task => {
                const project = projectByTaskId.get(task.id)
                if (!project) return null
                const opacity = computeTaskRecencyOpacity(task, sortedByRecency, recencySettings, now)
                const style = buildRecencyStyle(opacity, theme)
                const status = getTaskStatus(task, allStatuses)
                const isSelected = selectedTaskId === task.id
                return (
                  <div
                    key={task.id}
                    className={[
                      'mx-1.5 px-1.5 py-1 rounded-md cursor-pointer text-sm text-text flex items-center gap-1.5',
                      'transition-colors duration-(--motion-fast)',
                      isSelected ? 'bg-sel' : 'hover:bg-surface-3',
                    ].join(' ')}
                    style={style}
                    onClick={() => switchToTask(project.id, task.id)}
                    onContextMenu={(e) => onTaskContextMenu(e, project.id, task.id)}
                  >
                    <span className="text-text-muted text-xs shrink-0 max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap">{project.name}</span>
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">{task.name}</span>
                    {isWorkspaceTask(task) && (
                      <span className="text-2xs px-1 py-px rounded-sm bg-surface-3 text-text-muted ml-1.5 shrink-0">ws</span>
                    )}
                    {status && <StatusDot status={status} />}
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </>
  )
}

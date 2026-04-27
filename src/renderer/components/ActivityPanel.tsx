import React, { useState, useRef, useCallback } from 'react'
import type { Project, AppConfig } from '../../shared/types'
import { AI_TAB_TYPES, isWorkspaceTask } from '../../shared/types'
import type { TabStatusValue } from '../context/TabStatusContext'
import { buildRecencyStyle, computeTaskRecencyOpacity, sortTasksByRecency } from './taskRecency'
import './ActivityPanel.css'

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
    () => sortTasksByRecency(projects.flatMap(p => p.tasks)),
    [projects]
  )

  const projectByTaskId = React.useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of projects) {
      for (const task of project.tasks) {
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
        <div className="activity-splitter" onMouseDown={handleSplitterMouseDown} />
      )}
      <div className="activity-panel" style={panelStyle} ref={panelRef}>
        <div className="activity-header" onClick={toggleCollapse}>
          <span className="activity-header-chevron">{collapsed ? '▸' : '▾'}</span>
          Recent
        </div>
        {!collapsed && (
          <div className="activity-list">
            {sortedByRecency.length === 0 ? (
              <div className="activity-empty">No recent activity</div>
            ) : (
              sortedByRecency.map(task => {
                const project = projectByTaskId.get(task.id)
                if (!project) return null
                const opacity = computeTaskRecencyOpacity(task, sortedByRecency, recencySettings, now)
                const style = buildRecencyStyle(opacity, theme)
                const status = getTaskStatus(task, allStatuses)
                return (
                  <div
                    key={task.id}
                    className={`activity-item ${selectedTaskId === task.id ? 'selected' : ''}`}
                    style={style}
                    onClick={() => switchToTask(project.id, task.id)}
                    onContextMenu={(e) => onTaskContextMenu(e, project.id, task.id)}
                  >
                    <span className="activity-project-prefix">{project.name}</span>
                    <span className="activity-task-name">{task.name}</span>
                    {isWorkspaceTask(task) && <span className="sidebar-ssh-badge">ws</span>}
                    {status && <span className={`sidebar-status sidebar-status-${status}`} />}
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

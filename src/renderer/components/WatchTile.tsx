// src/renderer/components/WatchTile.tsx
import React, { useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import { useTabStatus } from '../context/TabStatusContext'
import type { TabStatusValue } from '../context/TabStatusContext'
import { WatchPeek } from './WatchPeek'

interface Props {
  projectId: string
  taskId: string
  pane: 'left' | 'right'
  tabId: string
  pinKey: string
  index: number
  isDragging: boolean
  suppressPeek: boolean
  onPinMouseDown: (event: React.MouseEvent, key: string) => void
}

function dotClass(status: TabStatusValue): string {
  switch (status) {
    case 'working':   return 'bg-status-working animate-pulse'
    case 'attention': return 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]'
    case 'exited':    return 'bg-status-exited'
    default:          return 'bg-status-exited'
  }
}

export function WatchTile({
  projectId,
  taskId,
  pane,
  tabId,
  pinKey,
  index,
  isDragging,
  suppressPeek,
  onPinMouseDown
}: Props): React.ReactElement | null {
  const actions = useApp()
  const status = useTabStatus(tabId)
  const ref = useRef<HTMLButtonElement>(null)
  const [hover, setHover] = useState(false)
  const leaveTimer = useRef<number | null>(null)
  const suppressClickRef = useRef(false)

  const project = actions.projects.find(p => p.id === projectId)
  const task = project?.tasks.find(t => t.id === taskId)
  const tab = task?.tabs[pane].find(x => x.id === tabId)
  if (!task || !tab) return null

  const viewState = actions.getTaskViewState(task)
  const isActive =
    actions.selectedProjectId === projectId &&
    actions.selectedTaskId === taskId &&
    viewState.activeTab[pane] === tabId &&
    (pane === 'left' || viewState.splitOpen)

  const onClick = () => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    actions.switchToTask(projectId, taskId)
    actions.setActiveTab(projectId, taskId, pane, tabId)
  }
  const onEnter = () => {
    if (suppressPeek) return
    if (leaveTimer.current) { window.clearTimeout(leaveTimer.current); leaveTimer.current = null }
    setHover(true)
  }
  const onLeave = () => {
    leaveTimer.current = window.setTimeout(() => setHover(false), 150)
  }
  const onMouseDown = (event: React.MouseEvent) => {
    setHover(false)
    const startX = event.clientX
    const startY = event.clientY
    const onMoveOnce = (e: MouseEvent) => {
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) >= 4) {
        suppressClickRef.current = true
      }
      document.removeEventListener('mousemove', onMoveOnce)
    }
    document.addEventListener('mousemove', onMoveOnce)
    document.addEventListener('mouseup', () => {
      document.removeEventListener('mousemove', onMoveOnce)
    }, { once: true })
    onPinMouseDown(event, pinKey)
  }

  const anchor = ref.current?.getBoundingClientRect() ?? null
  const showPeek = hover && !suppressPeek && anchor

  return (
    <>
      <button
        ref={ref}
        type="button"
        data-pin-key={pinKey}
        data-pin-index={index}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className={[
          'px-3 flex items-center gap-2 min-w-[180px] max-w-[260px] bg-transparent border-0 cursor-pointer text-text shrink select-none',
          isActive
            ? 'bg-surface-2 shadow-[inset_0_2px_0_var(--color-accent-400)]'
            : 'hover:bg-surface-2',
          isDragging ? 'opacity-[0.45]' : ''
        ].join(' ')}
        title={tab.title}
      >
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotClass(status)}`} />
        <span className="truncate text-sm">{tab.title}</span>
      </button>
      {showPeek && (
        <WatchPeek
          projectId={projectId}
          taskId={taskId}
          pane={pane}
          tabId={tabId}
          anchorRect={anchor}
          onEnter={onEnter}
          onLeave={onLeave}
        />
      )}
    </>
  )
}

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
}

function dotClass(status: TabStatusValue): string {
  switch (status) {
    case 'working':   return 'bg-green-400 animate-pulse'
    case 'attention': return 'bg-amber-400'
    case 'exited':    return 'bg-text-subtle/50'
    default:          return 'bg-teal-400/70'
  }
}

export function WatchTile({ projectId, taskId, pane, tabId }: Props): React.ReactElement | null {
  const actions = useApp()
  const status = useTabStatus(tabId)
  const ref = useRef<HTMLButtonElement>(null)
  const [hover, setHover] = useState(false)
  const leaveTimer = useRef<number | null>(null)

  const project = actions.projects.find(p => p.id === projectId)
  const task = project?.tasks.find(t => t.id === taskId)
  const tab = task?.tabs[pane].find(x => x.id === tabId)
  if (!task || !tab) return null

  const onClick = () => {
    actions.switchToTask(projectId, taskId)
    actions.setActiveTab(projectId, taskId, pane, tabId)
  }
  const onEnter = () => {
    if (leaveTimer.current) { window.clearTimeout(leaveTimer.current); leaveTimer.current = null }
    setHover(true)
  }
  const onLeave = () => {
    leaveTimer.current = window.setTimeout(() => setHover(false), 150)
  }

  const anchor = ref.current?.getBoundingClientRect() ?? null

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className="px-3 flex items-center gap-2 min-w-[180px] max-w-[260px] hover:bg-surface-2 bg-transparent border-0 cursor-pointer text-text shrink"
        title={tab.title}
      >
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotClass(status)}`} />
        <span className="truncate text-sm">{tab.title}</span>
      </button>
      {hover && anchor && (
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

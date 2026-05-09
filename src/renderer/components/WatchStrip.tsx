// src/renderer/components/WatchStrip.tsx
import React from 'react'
import { useApp } from '../context/AppContext'
import { WatchTile } from './WatchTile'
import { paletteEvents } from '../palette/paletteEvents'

interface PinnedRef {
  projectId: string
  taskId: string
  pane: 'left' | 'right'
  tabId: string
}

export function WatchStrip(): React.ReactElement | null {
  const actions = useApp()
  if (actions.watchStripHidden) return null

  const pins: PinnedRef[] = []
  for (const project of actions.projects) {
    for (const task of project.tasks) {
      for (const pane of ['left', 'right'] as const) {
        for (const tab of task.tabs[pane]) {
          if (tab.pinned) pins.push({ projectId: project.id, taskId: task.id, pane, tabId: tab.id })
        }
      }
    }
  }
  if (pins.length === 0) return null

  return (
    <div className="border-t border-border bg-surface flex items-stretch gap-px overflow-x-auto h-8 shrink-0">
      {pins.map(ref => (
        <WatchTile key={`${ref.projectId}:${ref.taskId}:${ref.pane}:${ref.tabId}`} {...ref} />
      ))}
      <button
        type="button"
        onClick={() => paletteEvents.emit('palette-prefix-set', '>pin')}
        className="px-3 text-xs text-text-subtle hover:text-text bg-transparent border-0 cursor-pointer shrink-0"
        title="Pin a tab to watch strip (opens command palette)"
      >
        + pin
      </button>
    </div>
  )
}

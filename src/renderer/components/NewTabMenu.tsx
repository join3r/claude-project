import React, { useState } from 'react'
import { Plus } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { findStreamOfTask } from '../../shared/streams'
import { taskPlace } from '../../shared/project-label'
import { ContextMenu, type ContextMenuItem } from './ui'
import type { MenuAnchor } from '../hooks/useMenuPosition'
import { paletteEvents } from '../palette/paletteEvents'
import type { PaneRef } from './paneFocus'

const btnCls = 'bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md inline-flex items-center hover:bg-surface-3 hover:text-text transition-colors duration-(--motion-fast)'

/**
 * The tab bar's "+": what a task can hold besides its agent (terminal, browser,
 * note), then a new task in the same stream, since a second agent is a new task.
 * It sits at the end of each tab bar, and in the content toolbar while a task
 * shows no tab bar (one tab or none).
 */
export default function NewTabMenu({
  projectId,
  taskId,
  pane,
  className = ''
}: {
  projectId: string
  taskId: string
  pane: PaneRef
  className?: string
}): React.ReactElement {
  const { selectedProject, addTab, createNote, openOrFocusNoteTab } = useApp()
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const project = selectedProject?.id === projectId ? selectedProject : null
  const place = project ? taskPlace(project.name, findStreamOfTask(project, taskId)) : null

  const items: ContextMenuItem[] = [
    { label: 'Terminal', shortcut: 'CmdOrCtrl+T', onSelect: () => { addTab(projectId, taskId, pane, 'terminal') } },
    { label: 'Browser', onSelect: () => { addTab(projectId, taskId, pane, 'browser') } },
    {
      label: 'Note',
      onSelect: () => {
        const note = createNote(projectId, 'Untitled')
        openOrFocusNoteTab(projectId, taskId, pane, note.id)
      }
    },
    {
      label: place ? `New task in ${place}…` : 'New task…',
      shortcut: 'CmdOrCtrl+N',
      dividerBefore: true,
      onSelect: () => paletteEvents.emit('open-new-task')
    }
  ]

  return (
    <div className={`flex [-webkit-app-region:no-drag] ${className}`}>
      <button
        type="button"
        className={btnCls}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title="New tab or task"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setMenu(menu ? null : { x: rect.left, y: rect.bottom + 4 })
        }}
      >
        <Plus size={14} strokeWidth={2} />
      </button>
      <ContextMenu menu={menu} items={items} onClose={() => setMenu(null)} />
    </div>
  )
}

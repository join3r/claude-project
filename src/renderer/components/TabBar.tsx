import React, { useRef } from 'react'
import { useApp } from '../context/AppContext'
import { useTabStatus } from '../context/TabStatusContext'
import { AI_TAB_TYPES, isShellCommandProject } from '../../shared/types'
import type { Tab, TabType } from '../../shared/types'
import { getTabDropIndex } from './tabDrag'
import type { TabDragState, TabDropTarget } from './tabDrag'
import './TabBar.css'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  pane: 'left' | 'right'
  projectId: string
  taskId: string
  tabDragState: TabDragState | null
  tabDropTarget: TabDropTarget | null
  onTabDragStateChange: (dragState: TabDragState | null) => void
  onTabDropTargetChange: (dropTarget: TabDropTarget | null) => void
  onTabDragComplete?: (pane: 'left' | 'right') => void
}

const DRAG_THRESHOLD = 5

function tabIcon(type: TabType): string {
  if (type === 'terminal') return '>'
  if (type === 'browser') return '\u25C9'
  if (type === 'claude') return '\u2726'
  if (type === 'codex') return '\u25EB'
  if (type === 'opencode') return '\u25C7'
  return '>'
}

function TabStatusIndicator({ tabId }: { tabId: string }): React.ReactElement | null {
  const status = useTabStatus(tabId)
  if (!status) return null
  return <span className={`tab-status tab-status-${status}`} />
}

function getDropPane(value: string | undefined): 'left' | 'right' | null {
  if (value === 'left' || value === 'right') return value
  return null
}

function resolveTabDropTarget(projectId: string, taskId: string, cursorX: number, cursorY: number, draggedTabId: string): TabDropTarget | null {
  const tabLists = document.querySelectorAll<HTMLElement>(
    `.tab-list[data-project-id="${projectId}"][data-task-id="${taskId}"]`
  )

  for (const tabList of tabLists) {
    const rect = tabList.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (cursorX < rect.left || cursorX > rect.right || cursorY < rect.top || cursorY > rect.bottom) continue

    const targetPane = getDropPane(tabList.dataset.pane)
    if (!targetPane) continue

    const items = Array.from(tabList.querySelectorAll<HTMLElement>('.tab')).map((item) => {
      const itemRect = item.getBoundingClientRect()
      return {
        id: item.dataset.tabId ?? '',
        index: Number(item.dataset.tabIndex ?? '-1'),
        left: itemRect.left,
        width: itemRect.width
      }
    })

    return {
      pane: targetPane,
      index: getTabDropIndex(items, cursorX, draggedTabId)
    }
  }

  const panes = document.querySelectorAll<HTMLElement>(
    `.pane[data-project-id="${projectId}"][data-task-id="${taskId}"]`
  )

  for (const paneElement of panes) {
    const rect = paneElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (cursorX < rect.left || cursorX > rect.right || cursorY < rect.top || cursorY > rect.bottom) continue

    const targetPane = getDropPane(paneElement.dataset.pane)
    if (!targetPane) continue

    const paneTabs = paneElement.querySelectorAll('.tab')
    if (paneTabs.length === 0) {
      return {
        pane: targetPane,
        index: 0
      }
    }
  }

  return null
}

export default function TabBar({
  tabs,
  activeTabId,
  pane,
  projectId,
  taskId,
  tabDragState,
  tabDropTarget,
  onTabDragStateChange,
  onTabDropTargetChange,
  onTabDragComplete
}: Props): React.ReactElement {
  const { selectedProject, addTab, removeTab, setActiveTab, moveTab, config } = useApp()
  const suppressClickRef = useRef(false)
  if (!selectedProject) return <div className="tab-bar" />

  const isTabDragActive = tabDragState?.projectId === projectId && tabDragState.taskId === taskId
  const isDropTargetPane = isTabDragActive && tabDropTarget?.pane === pane

  const handleAdd = (type: TabType) => {
    addTab(projectId, taskId, pane, type)
  }

  const handleTabMouseDown = (event: React.MouseEvent, tabId: string, index: number) => {
    if (event.button !== 0) return

    const startX = event.clientX
    const startY = event.clientY
    let dragging = false
    let latestDropTarget: TabDropTarget | null = null

    const dragState: TabDragState = {
      projectId,
      taskId,
      tabId,
      fromPane: pane,
      fromIndex: index
    }

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD) {
          return
        }

        dragging = true
        suppressClickRef.current = true
        document.body.style.cursor = 'grabbing'
        onTabDragStateChange(dragState)
      }

      latestDropTarget = resolveTabDropTarget(projectId, taskId, moveEvent.clientX, moveEvent.clientY, tabId)
      onTabDropTargetChange(latestDropTarget)
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''

      if (dragging && latestDropTarget) {
        moveTab(projectId, taskId, pane, tabId, latestDropTarget.pane, latestDropTarget.index)
        onTabDragComplete?.(latestDropTarget.pane)
      }

      if (dragging) {
        onTabDragStateChange(null)
        onTabDropTargetChange(null)
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  return (
    <div className="tab-bar">
      <div
        className={`tab-list ${isDropTargetPane ? 'tab-list-drop-active' : ''}`}
        data-project-id={projectId}
        data-task-id={taskId}
        data-pane={pane}
      >
        {tabs.map((tab, index) => (
          <React.Fragment key={tab.id}>
            {isDropTargetPane && tabDropTarget?.index === index && (
              <div className="tab-drop-indicator" />
            )}
            <div
              className={`tab ${tab.id === activeTabId ? 'tab-active' : ''} ${tabDragState?.tabId === tab.id ? 'tab-dragging' : ''}`}
              data-tab-id={tab.id}
              data-tab-index={index}
              onClick={() => {
                if (suppressClickRef.current) return
                setActiveTab(projectId, taskId, pane, tab.id)
              }}
              onMouseDown={(event) => handleTabMouseDown(event, tab.id, index)}
            >
              {index < 9 && (
                <span className="tab-shortcut-hint">
                  {pane === 'left' ? `⌘${index + 1}` : `⇧${index + 1}`}
                </span>
              )}
              <span className="tab-icon">{tabIcon(tab.type)}</span>
              <TabStatusIndicator tabId={tab.id} />
              <span className="tab-title">{tab.title}</span>
              <button
                className="tab-close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  removeTab(projectId, taskId, pane, tab.id)
                }}
                title="Close tab (⌘W)"
              >
                &times;
              </button>
            </div>
          </React.Fragment>
        ))}
        {isDropTargetPane && tabDropTarget?.index === tabs.length && (
          <div className="tab-drop-indicator" />
        )}
      </div>
      <div className="tab-actions">
        <button className="tab-add-btn" onClick={() => handleAdd('terminal')} title="New terminal (⌘T)">
          &gt;_
        </button>
        <button className="tab-add-btn" onClick={() => handleAdd('browser')} title="New browser">
          &#9673;
        </button>
        {config?.enableClaude && selectedProject && !isShellCommandProject(selectedProject) && (
          <button className="tab-add-btn" onClick={() => handleAdd('claude')} title="New Claude Code">
            &#10022;
          </button>
        )}
        {config?.enableCodex && selectedProject && !isShellCommandProject(selectedProject) && (
          <button className="tab-add-btn" onClick={() => handleAdd('codex')} title="New Codex">
            &#9707;
          </button>
        )}
        {config?.enableOpencode && selectedProject && !isShellCommandProject(selectedProject) && (
          <button className="tab-add-btn" onClick={() => handleAdd('opencode')} title="New OpenCode">
            &#9671;
          </button>
        )}
      </div>
    </div>
  )
}

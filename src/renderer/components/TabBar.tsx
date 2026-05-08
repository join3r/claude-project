import React, { useRef, useState } from 'react'
import { Pin, PinOff } from 'lucide-react'
import { useApp } from '../context/AppContext'
import { useTabStatus } from '../context/TabStatusContext'
import { AI_TAB_TYPES, isHomeTab, isShellCommandProject } from '../../shared/types'
import type { Tab, TabType } from '../../shared/types'
import { getTabDropIndex } from './tabDrag'
import type { TabDragState, TabDropTarget } from './tabDrag'
import { isPinnable } from './terminalStatus'

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
  if (type === 'browser') return '◉'
  if (type === 'claude') return '✦'
  if (type === 'codex') return '◫'
  if (type === 'opencode') return '◇'
  return '>'
}

function TabStatusIndicator({ tabId }: { tabId: string }): React.ReactElement | null {
  const status = useTabStatus(tabId)
  if (!status) return null

  const stateClasses =
    status === 'working'
      ? 'bg-status-working animate-pulse'
      : status === 'attention'
        ? 'bg-status-attention shadow-[0_0_4px_var(--color-status-attention)]'
        : 'bg-status-exited'

  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${stateClasses}`} />
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
  const { selectedProject, addTab, removeTab, setActiveTab, moveTab, config, setTabPinned } = useApp()
  const suppressClickRef = useRef(false)
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  if (!selectedProject) return <div className="tab-bar flex items-stretch h-9 bg-surface-2 border-b border-border [-webkit-app-region:drag]" />

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
    <>
    <div className="tab-bar flex items-stretch h-9 bg-surface-2 border-b border-border [-webkit-app-region:drag]">
      <div
        className={[
          'tab-list',
          'flex flex-1 overflow-x-auto overflow-y-hidden relative [&::-webkit-scrollbar]:h-0 [-webkit-app-region:no-drag]',
          isDropTargetPane ? 'shadow-[inset_0_-2px_0_var(--color-accent-400)]' : ''
        ].join(' ')}
        data-project-id={projectId}
        data-task-id={taskId}
        data-pane={pane}
      >
        {tabs.map((tab, index) => (
          <React.Fragment key={tab.id}>
            {isDropTargetPane && tabDropTarget?.index === index && (
              <div className="w-0.5 shrink-0 self-stretch bg-accent-400 shadow-[0_0_6px_color-mix(in_srgb,var(--color-accent-400)_55%,transparent)]" />
            )}
            <div
              className={[
                'tab',
                'group relative flex items-center gap-1.5 h-full px-3 text-[12.5px] cursor-pointer whitespace-nowrap text-text-muted min-w-0 select-none hover:text-text',
                'data-[active=true]:text-text',
                'data-[active=true]:after:absolute data-[active=true]:after:inset-x-2 data-[active=true]:after:bottom-0 data-[active=true]:after:h-0.5 data-[active=true]:after:bg-accent-400',
                tabDragState?.tabId === tab.id ? 'opacity-[0.45]' : ''
              ].join(' ')}
              data-tab-id={tab.id}
              data-tab-index={index}
              data-active={tab.id === activeTabId ? 'true' : undefined}
              onClick={() => {
                if (suppressClickRef.current) return
                setActiveTab(projectId, taskId, pane, tab.id)
              }}
              onMouseDown={(event) => handleTabMouseDown(event, tab.id, index)}
              onContextMenu={(e) => {
                e.preventDefault()
                if (isHomeTab(tab)) return
                setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
              }}
            >
              {index < 9 && (
                <span className="text-[10px] text-text-subtle px-1 py-px rounded-sm bg-surface-3 pointer-events-none shrink-0 invisible [body.meta-held_&]:visible">
                  {pane === 'left' ? `⌘${index + 1}` : `⇧${index + 1}`}
                </span>
              )}
              <span className="text-[11px] shrink-0">{tabIcon(tab.type)}</span>
              <TabStatusIndicator tabId={tab.id} />
              <span className="overflow-hidden text-ellipsis">{tab.title}</span>
              {isPinnable(tab) && (
                <button
                  className={`bg-transparent border-0 cursor-pointer text-[12px] px-0.5 rounded-sm shrink-0 leading-none hover:bg-surface-3 transition-opacity ${tab.pinned ? 'opacity-100 text-accent' : 'opacity-0 group-hover:opacity-100 text-text-muted hover:text-text'}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    setTabPinned(projectId, taskId, pane, tab.id, !tab.pinned)
                  }}
                  title={tab.pinned ? 'Unpin from watch strip' : 'Pin to watch strip'}
                >
                  {tab.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                </button>
              )}
              {!isHomeTab(tab) && (
                <button
                  className="bg-transparent border-0 text-text-muted cursor-pointer text-[14px] px-0.5 rounded-sm shrink-0 leading-none hover:bg-surface-3 hover:text-text opacity-0 group-hover:opacity-100 transition-opacity"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeTab(projectId, taskId, pane, tab.id)
                  }}
                  title="Close tab (⌘W)"
                >
                  &times;
                </button>
              )}
            </div>
          </React.Fragment>
        ))}
        {isDropTargetPane && tabDropTarget?.index === tabs.length && (
          <div className="w-0.5 shrink-0 self-stretch bg-accent-400 shadow-[0_0_6px_color-mix(in_srgb,var(--color-accent-400)_55%,transparent)]" />
        )}
      </div>
      <div className="flex px-1 gap-0.5 [-webkit-app-region:no-drag]">
        <button className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded text-[11px] font-mono hover:bg-surface-3 hover:text-text" onClick={() => handleAdd('terminal')} title="New terminal (⌘T)">
          &gt;_
        </button>
        <button className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded text-[11px] font-mono hover:bg-surface-3 hover:text-text" onClick={() => handleAdd('browser')} title="New browser">
          &#9673;
        </button>
        {config?.enableClaude && selectedProject && !isShellCommandProject(selectedProject) && (
          <button className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded text-[11px] font-mono hover:bg-surface-3 hover:text-text" onClick={() => handleAdd('claude')} title="New Claude Code">
            &#10022;
          </button>
        )}
        {config?.enableCodex && selectedProject && !isShellCommandProject(selectedProject) && (
          <button className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded text-[11px] font-mono hover:bg-surface-3 hover:text-text" onClick={() => handleAdd('codex')} title="New Codex">
            &#9707;
          </button>
        )}
        {config?.enableOpencode && selectedProject && !isShellCommandProject(selectedProject) && (
          <button className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded text-[11px] font-mono hover:bg-surface-3 hover:text-text" onClick={() => handleAdd('opencode')} title="New OpenCode">
            &#9671;
          </button>
        )}
      </div>
    </div>
    {tabMenu && (() => {
      const tab = tabs.find(t => t.id === tabMenu.tabId)
      if (!tab) return null
      const close = () => setTabMenu(null)
      return (
        <>
          <div className="fixed inset-0 z-30" onClick={close} onContextMenu={e => { e.preventDefault(); close() }} />
          <div
            style={{ left: tabMenu.x, top: tabMenu.y }}
            className="fixed z-40 min-w-[180px] bg-surface border border-border rounded shadow-lg text-sm py-1"
          >
            {isPinnable(tab) && (
              <button
                type="button"
                className="block w-full text-left px-3 py-1 hover:bg-surface-2 bg-transparent border-0 cursor-pointer text-text"
                onClick={() => {
                  setTabPinned(projectId, taskId, pane, tab.id, !tab.pinned)
                  close()
                }}
              >
                {tab.pinned ? 'Unpin from watch strip' : 'Pin to watch strip'}
              </button>
            )}
            {!isHomeTab(tab) && (
              <button
                type="button"
                className="block w-full text-left px-3 py-1 hover:bg-surface-2 bg-transparent border-0 cursor-pointer text-text"
                onClick={() => { removeTab(projectId, taskId, pane, tab.id); close() }}
              >
                Close tab
              </button>
            )}
          </div>
        </>
      )
    })()}
    </>
  )
}

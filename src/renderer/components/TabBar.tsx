import React, { useEffect, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import { useTabStatus } from '../context/TabStatusContext'
import { isRenamableTab } from '../../shared/types'
import type { Tab, TabType } from '../../shared/types'
import { useMenuPosition } from '../hooks/useMenuPosition'
import { resolveTabDropTarget } from './tabDrag'
import type { TabDragState, TabDropTarget } from './tabDrag'
import { formatShortcutForApp } from '../../shared/shortcut-label'
import { menuCls, menuItemCls } from './ui'
import NewTabMenu from './NewTabMenu'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  /** This pane's column in the task's row. */
  paneIndex: number
  projectId: string
  taskId: string
  /** The task's agent (or terminal) tab: no close button, closes with the task. */
  mainTabId?: string
  /** Whether this pane has the task's focus: Cmd+digit addresses its tabs. */
  focused: boolean
  style?: React.CSSProperties
  tabDragState: TabDragState | null
  tabDropTarget: TabDropTarget | null
  onTabDragStateChange: (dragState: TabDragState | null) => void
  onTabDropTargetChange: (dropTarget: TabDropTarget | null) => void
}

const DRAG_THRESHOLD = 5

function tabIcon(type: TabType): string {
  if (type === 'terminal') return '>'
  if (type === 'browser') return '◉'
  if (type === 'claude' || type === 'claude-chat') return '✦'
  if (type === 'codex') return '◫'
  if (type === 'pi') return 'π'
  return '>'
}

function TabStatusIndicator({ tabId }: { tabId: string }): React.ReactElement | null {
  const status = useTabStatus(tabId)
  if (!status) return null

  const stateClasses =
    status === 'working'
      ? 'bg-status-working status-pulse'
      : status === 'attention'
        ? 'bg-status-attention shadow-[0_0_4px_var(--color-status-attention)]'
        : 'bg-status-exited'

  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${stateClasses}`} />
}

export default function TabBar({
  tabs,
  activeTabId,
  paneIndex,
  projectId,
  taskId,
  mainTabId,
  focused,
  style,
  tabDragState,
  tabDropTarget,
  onTabDragStateChange,
  onTabDropTargetChange
}: Props): React.ReactElement {
  const { selectedProject, removeTab, setActiveTab, moveTab, splitTabRight, renameTab } = useApp()
  const suppressClickRef = useRef(false)
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const tabMenuPos = useMenuPosition<HTMLDivElement>(tabMenu)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const beginRename = (tab: Tab) => {
    if (!isRenamableTab(tab)) return
    setRenamingTabId(tab.id)
    setRenameValue(tab.title)
  }

  const cancelRename = () => {
    setRenamingTabId(null)
    setRenameValue('')
  }

  const commitRename = (tabId: string) => {
    const trimmed = renameValue.trim()
    if (trimmed) renameTab(projectId, taskId, tabId, trimmed)
    setRenamingTabId(null)
    setRenameValue('')
  }

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId: string }>).detail
      if (!detail) return
      const tab = tabs.find(t => t.id === detail.tabId)
      if (!tab) return
      if (!isRenamableTab(tab)) return
      setRenamingTabId(tab.id)
      setRenameValue(tab.title)
    }
    window.addEventListener('request-tab-rename', handler as EventListener)
    return () => window.removeEventListener('request-tab-rename', handler as EventListener)
  }, [tabs])

  useEffect(() => {
    if (renamingTabId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingTabId])
  if (!selectedProject) return <div className="tab-bar flex items-stretch h-(--ctl-h-lg) bg-surface-2 border-b-[0.5px] border-border [-webkit-app-region:drag]" style={style} data-pane-index={paneIndex} />

  const isTabDragActive = tabDragState?.projectId === projectId && tabDragState.taskId === taskId
  const isDropTargetPane = isTabDragActive && tabDropTarget?.kind === 'tab' && !tabDropTarget.inBody && tabDropTarget.pane === paneIndex
  const dropIndex = isDropTargetPane && tabDropTarget?.kind === 'tab' ? tabDropTarget.index : null

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
      fromPane: paneIndex,
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
        const { inBody: _inBody, ...target } = latestDropTarget
        moveTab(projectId, taskId, tabId, target)
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
    <div
      className="tab-bar flex items-stretch min-w-0 h-(--ctl-h-lg) bg-surface-2 border-b-[0.5px] border-border [-webkit-app-region:drag]"
      style={style}
      data-pane-index={paneIndex}
    >
      <div
        className={[
          'tab-list',
          'flex flex-1 overflow-x-auto overflow-y-hidden relative [&::-webkit-scrollbar]:h-0 [-webkit-app-region:no-drag]',
          isDropTargetPane ? 'shadow-[inset_0_-2px_0_var(--color-accent)]' : ''
        ].join(' ')}
        data-project-id={projectId}
        data-task-id={taskId}
        data-pane-index={paneIndex}
      >
        {tabs.map((tab, index) => (
          <React.Fragment key={tab.id}>
            {dropIndex === index && (
              <div className="w-0.5 shrink-0 self-stretch bg-accent shadow-[0_0_6px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]" />
            )}
            <div
              className={[
                'tab',
                'group relative flex items-center gap-1.5 h-full px-3 text-base cursor-pointer whitespace-nowrap text-text-muted min-w-0 select-none hover:text-text',
                'transition-colors duration-(--motion-fast)',
                'data-[active=true]:text-text data-[active=true]:bg-bg',
                tabDragState?.tabId === tab.id ? 'opacity-[0.45]' : ''
              ].join(' ')}
              data-tab-id={tab.id}
              data-tab-index={index}
              data-active={tab.id === activeTabId ? 'true' : undefined}
              onClick={() => {
                if (suppressClickRef.current) return
                setActiveTab(projectId, taskId, tab.id)
              }}
              onMouseDown={(event) => handleTabMouseDown(event, tab.id, index)}
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
              }}
            >
              {focused && index < 9 && (
                <span className="text-2xs text-text-subtle px-1 py-px rounded-sm bg-surface-3 pointer-events-none shrink-0 invisible [body.meta-held_&]:visible">
                  {formatShortcutForApp(`CmdOrCtrl+${index + 1}`)}
                </span>
              )}
              <span className="text-xs shrink-0">{tabIcon(tab.type)}</span>
              <TabStatusIndicator tabId={tab.id} />
              {renamingTabId === tab.id ? (
                <input
                  ref={renameInputRef}
                  className="bg-field border border-border-focus text-text text-[inherit] px-1 py-px rounded-sm outline-none min-w-0 w-28"
                  value={renameValue}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitRename(tab.id)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelRename()
                    }
                  }}
                />
              ) : (
                <span className="overflow-hidden text-ellipsis">{tab.title}</span>
              )}
              {tab.id !== mainTabId && (
                <button
                  className="bg-transparent border-0 text-text-muted cursor-pointer text-md px-0.5 rounded-sm shrink-0 leading-none hover:bg-surface-3 hover:text-text opacity-0 group-hover:opacity-100 transition-opacity duration-(--motion-fast)"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeTab(projectId, taskId, tab.id)
                  }}
                  title={`Close tab (${formatShortcutForApp('CmdOrCtrl+W')})`}
                >
                  &times;
                </button>
              )}
            </div>
          </React.Fragment>
        ))}
        {dropIndex === tabs.length && (
          <div className="w-0.5 shrink-0 self-stretch bg-accent-400 shadow-[0_0_6px_color-mix(in_srgb,var(--color-accent-400)_55%,transparent)]" />
        )}
      </div>
      <NewTabMenu projectId={projectId} taskId={taskId} pane={paneIndex} className="px-1" />
    </div>
    {tabMenu && (() => {
      const tab = tabs.find(t => t.id === tabMenu.tabId)
      if (!tab) return null
      const close = () => setTabMenu(null)
      return (
        <>
          <div className="fixed inset-0 z-(--z-menu)" onClick={close} onContextMenu={e => { e.preventDefault(); close() }} />
          <div
            ref={tabMenuPos.ref}
            style={tabMenuPos.style}
            className={`fixed z-(--z-menu) min-w-[180px] ${menuCls}`}
          >
            {isRenamableTab(tab) && (
              <button
                type="button"
                className={menuItemCls}
                onClick={() => {
                  beginRename(tab)
                  close()
                }}
              >
                Rename tab
              </button>
            )}
            {tabs.length > 1 && (
              <button
                type="button"
                className={menuItemCls}
                onClick={() => { splitTabRight(projectId, taskId, tab.id); close() }}
              >
                Split right
              </button>
            )}
            {tab.id !== mainTabId && (
              <button
                type="button"
                className={menuItemCls}
                onClick={() => { void removeTab(projectId, taskId, tab.id); close() }}
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

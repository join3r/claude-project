import React, { useCallback, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import TabBar from './TabBar'
import TerminalTab from './TerminalTab'
import BrowserTab from './BrowserTab'
import AiToolTab from './AiToolTab'
import DiffTab from './DiffTab'
import EditorTab from './EditorTab'
import NotebookTab from './NotebookTab'
import NoteTab from './NoteTab'
import { AI_TAB_TYPES } from '../../shared/types'
import { isNotebookFile } from '../../shared/notebook'
import { dragDivider, showsTabBars } from '../../shared/panes'
import { tabSpawnDir } from '../../shared/streams'
import ClaudeChatTab from './claude-chat/ClaudeChatTab'
import TaskPromptBox from './TaskPromptBox'
import type { Tab, AiTabType, Project, Task } from '../../shared/types'
import { paneIndexOfElement, setFocusedPane, useFocusedPane } from './paneFocus'
import type { TabDragState, TabDropTarget } from './tabDrag'

interface Props {
  project: Project
  task: Task
  /** The task is the one on screen. */
  visible: boolean
  projectDir: string
}

/** Grid column of pane `index`: panes sit on odd columns, the dividers between them on even ones. */
/** A tab body's React key: its id, plus the directory its process runs in, if any. */
function bodyKey(tab: Tab, projectDir: string): string {
  const dir = tabSpawnDir(tab, projectDir)
  return dir === null ? tab.id : `${tab.id}@${dir}`
}

function paneColumn(index: number): number {
  return index * 2 + 1
}

/**
 * One task's row of panes, laid out as a CSS grid: a tab bar per pane on the
 * first row (only once the task has two tabs), the tab bodies on the second.
 *
 * Every tab body is a direct child of the grid, keyed by tab id and kept in a
 * fixed (id) order; which column it shows in is just its `grid-column`. Moving a
 * tab to another pane therefore neither remounts its component nor moves its DOM
 * node, so terminals keep their session and browser webviews don't reload.
 */
export default function TaskPanes({ project, task, visible, projectDir }: Props): React.ReactElement {
  const { effectiveTheme, setPaneWidths } = useApp()
  const focusedPane = useFocusedPane(task.id)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [dragWidths, setDragWidths] = useState<number[] | null>(null)
  const [tabDragState, setTabDragState] = useState<TabDragState | null>(null)
  const [tabDropTarget, setTabDropTarget] = useState<TabDropTarget | null>(null)

  const projectId = project.id
  const showBars = showsTabBars(task)
  const bodyRow = showBars ? 2 : 1
  const widths = dragWidths && dragWidths.length === task.panes.length ? dragWidths : task.panes.map(pane => pane.width)
  const gridTemplateColumns = widths.length === 0
    ? 'minmax(0, 1fr)'
    : widths.map(width => `minmax(0, ${width}fr)`).join(' 3px ')

  const handleDividerMouseDown = useCallback((divider: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    const grid = gridRef.current
    if (!grid) return
    const start = task.panes.map(pane => pane.width)
    let latest = start
    const widthsAt = (clientX: number): number[] => {
      const rect = grid.getBoundingClientRect()
      return dragDivider(start, divider, (clientX - rect.left) / rect.width)
    }
    const onMouseMove = (ev: MouseEvent): void => {
      latest = widthsAt(ev.clientX)
      setDragWidths(latest)
    }
    const onMouseUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      latest = widthsAt(ev.clientX)
      setDragWidths(null)
      setPaneWidths(projectId, task.id, latest)
    }
    document.body.style.cursor = 'col-resize'
    setDragWidths(start)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [projectId, task.id, task.panes, setPaneWidths])

  const rememberFocus = useCallback((e: React.SyntheticEvent) => {
    const pane = paneIndexOfElement(e.target as Element)
    if (pane !== null) setFocusedPane(task.id, pane)
  }, [task.id])

  const renderTab = (tab: Tab, tabVisible: boolean): React.ReactNode => {
    if (tab.type === 'terminal') {
      return <TerminalTab tabId={tab.id} visible={tabVisible} projectId={projectId} taskId={task.id} projectDir={projectDir} sshConfig={project.ssh} shellCommand={project.shellCommand} cwd={tab.cwd} />
    }
    if (tab.type === 'browser') {
      return <BrowserTab tabId={tab.id} visible={tabVisible} initialUrl={tab.url} projectId={projectId} taskId={task.id} sshConfig={project.ssh} />
    }
    if ((AI_TAB_TYPES as readonly string[]).includes(tab.type)) {
      return (
        <AiToolTab
          tabId={tab.id}
          toolType={tab.type as AiTabType}
          visible={tabVisible}
          sessionId={tab.sessionId}
          projectId={projectId}
          taskId={task.id}
          projectDir={projectDir}
          sshConfig={project.ssh}
          extraArgs={project.aiToolArgs?.[tab.type as AiTabType]}
        />
      )
    }
    if (tab.type === 'claude-chat') {
      return <ClaudeChatTab tabId={tab.id} visible={tabVisible} sessionId={tab.sessionId} projectId={projectId} taskId={task.id} projectDir={projectDir} sshConfig={project.ssh} extraArgs={project.aiToolArgs?.claude} />
    }
    if (tab.type === 'diff' && tab.filePath) {
      return <DiffTab tabId={tab.id} visible={tabVisible} filePath={tab.filePath} projectDir={projectDir} effectiveTheme={effectiveTheme} />
    }
    if (tab.filePath && (tab.type === 'notebook' || (tab.type === 'editor' && isNotebookFile(tab.filePath)))) {
      return <NotebookTab tabId={tab.id} visible={tabVisible} filePath={tab.filePath} projectDir={projectDir} projectId={projectId} taskId={task.id} effectiveTheme={effectiveTheme} />
    }
    if (tab.type === 'editor' && tab.filePath) {
      return <EditorTab tabId={tab.id} visible={tabVisible} filePath={tab.filePath} projectDir={projectDir} projectId={projectId} taskId={task.id} effectiveTheme={effectiveTheme} />
    }
    if (tab.type === 'note' && tab.noteId) {
      return <NoteTab noteId={tab.noteId} projectId={projectId} taskId={task.id} visible={tabVisible} effectiveTheme={effectiveTheme} />
    }
    return null
  }

  // Fixed order, independent of the layout: see the component comment.
  const bodies = task.panes
    .flatMap((pane, paneIndex) => pane.tabs.map(tab => ({ tab, paneIndex, active: tab.id === pane.activeTabId })))
    .sort((a, b) => (a.tab.id < b.tab.id ? -1 : a.tab.id > b.tab.id ? 1 : 0))

  const dropOverlay = tabDragState && tabDropTarget?.inBody ? tabDropTarget : null
  const isResizing = dragWidths !== null

  return (
    <div
      ref={gridRef}
      className="flex-1 min-h-0 min-w-0 grid relative overflow-hidden"
      style={{ gridTemplateColumns, gridTemplateRows: showBars ? 'auto minmax(0, 1fr)' : 'minmax(0, 1fr)' }}
      data-project-id={projectId}
      data-task-id={task.id}
      onMouseDownCapture={rememberFocus}
      onFocusCapture={rememberFocus}
    >
      {showBars && task.panes.map((pane, paneIndex) => (
        <TabBar
          key={`bar-${paneIndex}`}
          style={{ gridColumn: paneColumn(paneIndex), gridRow: 1 }}
          tabs={pane.tabs}
          activeTabId={pane.activeTabId}
          paneIndex={paneIndex}
          projectId={projectId}
          taskId={task.id}
          mainTabId={task.mainTabId}
          focused={task.panes.length === 1 || paneIndex === focusedPane}
          tabDragState={tabDragState}
          tabDropTarget={tabDropTarget}
          onTabDragStateChange={setTabDragState}
          onTabDropTargetChange={setTabDropTarget}
        />
      ))}
      {task.panes.slice(1).map((_, i) => (
        <div
          key={`divider-${i}`}
          className="bg-border cursor-col-resize hover:bg-accent active:bg-accent transition-colors duration-(--motion-fast)"
          style={{ gridColumn: paneColumn(i) + 1, gridRow: '1 / -1' }}
          onMouseDown={handleDividerMouseDown(i)}
        />
      ))}
      {task.panes.length === 0 && (
        <div className="relative min-w-0 min-h-0 overflow-hidden" style={{ gridColumn: 1, gridRow: 1 }} data-pane-index={0}>
          <TaskPromptBox
            project={project}
            taskId={task.id}
            taskName={task.name}
            projectDir={projectDir}
            visible={visible}
          />
        </div>
      )}
      {task.panes.map((pane, paneIndex) => (
        <div
          key={`slot-${paneIndex}`}
          className="pane-slot min-w-0 min-h-0"
          style={{ gridColumn: paneColumn(paneIndex), gridRow: bodyRow }}
          data-project-id={projectId}
          data-task-id={task.id}
          data-pane-index={paneIndex}
          data-tab-count={pane.tabs.length}
        />
      ))}
      {bodies.map(({ tab, paneIndex, active }) => (
        <div
          // A session tab mounts again (and spawns in the new folder) when the
          // task moves to another worktree; see `useTasks.moveTask`.
          key={bodyKey(tab, projectDir)}
          className="relative min-w-0 min-h-0 overflow-hidden"
          style={{ gridColumn: paneColumn(paneIndex), gridRow: bodyRow, display: active ? 'block' : 'none' }}
          data-tab-body={tab.id}
          data-project-id={projectId}
          data-task-id={task.id}
          data-pane-index={paneIndex}
        >
          {renderTab(tab, visible && active)}
        </div>
      ))}
      {dropOverlay && (
        <div
          className="relative pointer-events-none z-(--z-sticky)"
          style={{ gridColumn: paneColumn(dropOverlay.pane), gridRow: bodyRow }}
        >
          <div
            className={[
              'absolute inset-y-0 bg-accent/10 shadow-[inset_0_0_0_2px_var(--color-accent)] rounded-sm',
              dropOverlay.kind === 'tab' ? 'inset-x-0' : dropOverlay.side === 'left' ? 'left-0 w-1/2' : 'right-0 w-1/2'
            ].join(' ')}
          />
        </div>
      )}
      {/* Webviews and iframes swallow mouse events; a shield keeps a drag's moves coming. */}
      {(isResizing || tabDragState) && (
        <div className={`absolute inset-0 z-(--z-sticky) ${isResizing ? 'cursor-col-resize' : 'cursor-grabbing'}`} />
      )}
    </div>
  )
}

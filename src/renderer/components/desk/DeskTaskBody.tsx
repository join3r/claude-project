import React, { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import type { Project, Task } from '../../../shared/types'
import { findTabLocation } from '../../../shared/panes'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import TaskPanes from '../TaskPanes'
import StreamRunLogs from '../StreamRunLogs'
import { useStreamRun, type StreamRunLogsTarget } from '../../streamRuns'
import { streamRunCrashed } from '../../../shared/stream-run'
import { FileBrowserBody, hasLocalFileTabs } from '../FileBrowserPanel'
import { setFocusedPane, useFocusedPane } from '../paneFocus'
import {
  benchCurrentItem,
  benchNewTabPane,
  benchPanes,
  benchTabOfType,
  conversationTabId,
  taskTabIds,
  type BenchItem,
  type BenchPane,
  type BenchView
} from './benchLayout'
import { closeBenchRun, getBench, openBench, openBenchRun, setBench, useBench } from './benchState'

const ITEM_LABEL: Record<BenchItem, string> = {
  terminal: 'Terminal',
  browser: 'Browser',
  files: 'Files',
  changes: 'Changes',
  notes: 'Notes'
}

/**
 * One task's body (decision 9 of the redesign): the first Claude chat tab is
 * the conversation, full width, and everything else sits in the Bench: a
 * drawer under it, closed by default, behind the strip "▴ Terminal Browser
 * Files Changes Notes". Files, Changes (the git panel) and Notes are Bench
 * tabs, and a run opened from the status bar shows its log here too. A task
 * without a chat tab shows the Bench full size.
 */
export default function DeskTaskBody({ project, task, visible, projectDir }: {
  project: Project
  task: Task
  visible: boolean
  projectDir: string
}): React.ReactElement {
  const { addTab, setActiveTab } = useApp()
  const bench = useBench(task.id)
  const focusedPane = useFocusedPane(task.id)
  const chatTabId = conversationTabId(task)
  const panes = benchPanes(task, chatTabId)
  const local = hasLocalFileTabs(project)
  const view: BenchView = (!local && (bench.view === 'files' || bench.view === 'changes')) || (bench.view === 'run' && !bench.run)
    ? 'panes'
    : bench.view
  const open = !chatTabId || bench.open

  // A file, diff or note opened from a Bench panel shows in its pane right away.
  const tabIdsKey = taskTabIds(task).join('|')
  const knownTabs = useRef<string>(tabIdsKey)
  useEffect(() => {
    const before = new Set(knownTabs.current.split('|'))
    knownTabs.current = tabIdsKey
    if (!tabIdsKey.split('|').some(id => id && !before.has(id))) return
    const state = getBench(task.id)
    if (state.open && state.view !== 'panes') setBench(task.id, { view: 'panes' })
  }, [tabIdsKey, task.id])

  const pick = (item: BenchItem): void => {
    const current = open ? benchCurrentItem(panes, view, focusedPane) : null
    // The lit item again closes the drawer.
    if (chatTabId && current === item) {
      setBench(task.id, { open: false })
      return
    }
    if (item === 'terminal' || item === 'browser') {
      const existing = benchTabOfType(panes, item)
      if (existing) {
        setActiveTab(project.id, task.id, existing)
        const at = findTabLocation(task, existing)
        if (at) setFocusedPane(task.id, at.pane)
      } else {
        addTab(project.id, task.id, benchNewTabPane(panes, focusedPane), item)
      }
      openBench(task.id, 'panes')
      return
    }
    openBench(task.id, item)
  }

  const items: BenchItem[] = local ? ['terminal', 'browser', 'files', 'changes', 'notes'] : ['terminal', 'browser', 'notes']
  const current = open ? benchCurrentItem(panes, view, focusedPane) : null

  return (
    <TaskPanes
      project={project}
      task={task}
      visible={visible}
      projectDir={projectDir}
      desk={{
        chatTabId,
        open: bench.open,
        height: bench.height,
        view,
        strip: (
          <BenchStrip
            taskId={task.id}
            collapsible={!!chatTabId}
            open={open}
            items={items}
            current={current}
            panes={panes}
            onPick={pick}
            run={bench.run}
            runShown={open && view === 'run'}
            onRun={() => {
              // The lit run again closes the drawer, like the other items.
              if (chatTabId && open && view === 'run') setBench(task.id, { open: false })
              else setBench(task.id, { open: true, view: 'run' })
            }}
            onCloseRun={() => closeBenchRun(task.id)}
          />
        ),
        panel: visible && open && view === 'run' && bench.run ? (
          <div className="flex-1 flex flex-col min-h-0">
            <StreamRunLogs
              key={`${bench.run.projectId}:${bench.run.streamId}:${bench.run.commandId}`}
              {...bench.run}
              embedded={{
                onClose: () => closeBenchRun(task.id),
                onPick: (commandId) => bench.run && openBenchRun(task.id, { ...bench.run, commandId })
              }}
            />
          </div>
        ) : visible && open && view !== 'panes' ? (
          <div className="flex-1 overflow-auto flex flex-col min-h-0">
            <FileBrowserBody
              tab={view === 'changes' ? 'git' : view === 'files' ? 'files' : 'notes'}
              active={visible}
              pane={benchNewTabPane(panes, focusedPane)}
            />
          </div>
        ) : null
      }}
    />
  )
}

/** The Bench's strip: chevron, the items, the shortcut. Its top edge resizes the open drawer. */
function BenchStrip({ taskId, collapsible, open, items, current, panes, onPick, run, runShown, onRun, onCloseRun }: {
  taskId: string
  collapsible: boolean
  open: boolean
  items: BenchItem[]
  current: BenchItem | null
  panes: BenchPane[]
  onPick: (item: BenchItem) => void
  /** The run log the Bench holds, an entry of its own after the items. */
  run: StreamRunLogsTarget | null
  runShown: boolean
  onRun: () => void
  onCloseRun: () => void
}): React.ReactElement {
  const shortcut = formatShortcutForApp('CmdOrCtrl+`')
  const counts = { terminal: 0, browser: 0 }
  for (const pane of panes) {
    for (const tab of pane.tabs) if (tab.type === 'terminal' || tab.type === 'browser') counts[tab.type]++
  }

  const startResize = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const strip = e.currentTarget.parentElement
    const grid = strip?.closest<HTMLElement>('[data-task-id]')
    if (!strip || !grid) return
    const gridRect = grid.getBoundingClientRect()
    const startY = e.clientY
    const startHeight = gridRect.bottom - strip.getBoundingClientRect().bottom
    const max = gridRect.height * 0.75
    // Webviews and xterm swallow mouse moves: a shield keeps the drag's coming.
    const shield = document.createElement('div')
    shield.style.cssText = 'position:fixed;inset:0;z-index:2000;cursor:row-resize'
    document.body.appendChild(shield)
    const onMove = (ev: MouseEvent): void => {
      setBench(taskId, { height: Math.min(max, startHeight + startY - ev.clientY) })
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      shield.remove()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className="relative flex items-center gap-0.5 h-[32px] px-2 bg-surface border-t-[0.5px] border-border text-sm select-none"
      data-testid="desk-bench-strip"
    >
      {collapsible && open && (
        <div className="absolute left-0 right-0 -top-[3px] h-[6px] cursor-row-resize z-(--z-sticky)" onMouseDown={startResize} />
      )}
      {collapsible && (
        <button
          type="button"
          className="size-6 inline-flex items-center justify-center rounded-md bg-transparent border-0 text-text-muted cursor-pointer hover:text-text hover:bg-sel"
          aria-expanded={open}
          title={`${open ? 'Close' : 'Open'} the Bench (${shortcut})`}
          onClick={() => setBench(taskId, { open: !open })}
        >
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      )}
      {items.map(item => {
        const count = item === 'terminal' || item === 'browser' ? counts[item] : 0
        return (
          <button
            key={item}
            type="button"
            className={`h-6 px-2 rounded-md border-0 cursor-pointer text-sm transition-colors duration-(--motion-fast) ${item === current ? 'bg-sel text-text' : 'bg-transparent text-text-muted hover:text-text'}`}
            aria-pressed={item === current}
            title={item === 'terminal' || item === 'browser'
              ? count > 0 ? `Show the ${ITEM_LABEL[item].toLowerCase()}` : `Open a ${ITEM_LABEL[item].toLowerCase()} in the Bench`
              : `${ITEM_LABEL[item]} in the Bench`}
            onClick={() => onPick(item)}
          >
            {ITEM_LABEL[item]}
            {count > 1 && <span className="ml-1 font-mono text-xs text-text-subtle">{count}</span>}
          </button>
        )
      })}
      {run && <BenchRunItem run={run} shown={runShown} onShow={onRun} onClose={onCloseRun} />}
      <span className="flex-1" />
      {collapsible && <span className="font-mono text-xs text-text-subtle">{shortcut}</span>}
    </div>
  )
}

/** The strip's entry for the run log the Bench holds: its state dot, the command's name, ×. */
function BenchRunItem({ run: target, shown, onShow, onClose }: {
  run: StreamRunLogsTarget
  shown: boolean
  onShow: () => void
  onClose: () => void
}): React.ReactElement {
  const { projects } = useApp()
  const run = useStreamRun(target.projectId, target.streamId, target.commandId)
  const stream = projects.find(p => p.id === target.projectId)?.streams.find(s => s.id === target.streamId)
  const name = run?.name ?? 'Log'
  const dot = run?.status === 'running' ? 'bg-running' : run && streamRunCrashed(run) ? 'bg-crashed' : 'bg-text-subtle'
  return (
    <span
      className={`group/run inline-flex items-center h-6 pl-2 pr-0.5 rounded-md text-sm transition-colors duration-(--motion-fast) ${shown ? 'bg-sel text-text' : 'text-text-muted hover:text-text'}`}
      data-testid="desk-bench-run"
    >
      <button
        type="button"
        className="inline-flex items-center gap-1.5 bg-transparent border-0 p-0 cursor-pointer text-inherit text-sm"
        aria-pressed={shown}
        title={`${name} log${stream && !stream.isMain ? ` · ${stream.name}` : ''}`}
        onClick={onShow}
      >
        <span className={`size-1.5 rounded-full ${dot}`} />
        {name}
      </button>
      <button
        type="button"
        className="size-5 inline-flex items-center justify-center bg-transparent border-0 rounded-sm cursor-pointer text-text-subtle hover:text-text"
        title="Close the log (the app keeps running)"
        onClick={onClose}
      >
        <X size={11} />
      </button>
    </span>
  )
}

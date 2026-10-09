import React, { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { AtSign, Eraser, Play, RotateCw, Square } from 'lucide-react'
import { DEFAULT_CONFIG, isAgentTabType } from '../../shared/types'
import {
  addCellAt,
  applyKernelEventToOutputs,
  changeCellTypeAt,
  clearAllOutputs,
  deleteCellAt,
  isNotebookCellCollapsed,
  moveCellById,
  notebookCondaEnvFromMetadata,
  notebookCondaOverridePayload,
  notebookKernelCondaSelection,
  notebookKernelEnvControlLabel,
  notebookKernelEnvControlTitle,
  notebookProjectDefaultOptionLabel,
  parseNotebook,
  replaceCellOutputs,
  serializeNotebook,
  setNotebookCellCollapsed,
  storedCellIds,
  setNotebookCondaEnvMetadata,
  updateCellSource,
  type NotebookCellType,
  type NotebookDocument,
  type NotebookKernelStatus
} from '../../shared/notebook'
import {
  condaEnvFromSelection,
  condaSavedOptionLabel,
  condaSavedOptionVisible,
  condaSelectValue,
  lastPathSegment,
  type CondaEnvInfo,
  type ProjectCondaSelection
} from '../../shared/conda'
import {
  beginRunAll,
  beginSingleRun,
  cellIdFromRequestId,
  codeCellIdsAbove,
  completeRun,
  idleRunQueue,
  makeExecuteRequestId,
  notebookRunAboveEnabled,
  notebookRunAboveTitle,
  notebookRunAllEnabled,
  notebookRunAllTitle,
  notebookRunQueueBusy,
  type NotebookRunQueueState
} from '../../shared/notebook-execute'
import type { editor } from 'monaco-editor'
import { useApp } from '../context/AppContext'
import { useDirtyBufferStore } from '../context/DirtyBufferContext'
import { FILE_BROWSER_REFRESH_MS } from '../hooks/fileBrowserRefresh'
import NotebookCellView from './NotebookCell'
import { scheduleResumeAfterNotebookReorder } from './notebookCellEditor'
import ThemedSelect from './ThemedSelect'
import { formatShortcutForApp, shortcutPlatform } from '../../shared/shortcut-label'
import { agentLinkPath, agentLinkShortcut, formatAgentLink, selectionLines } from '../../shared/agent-link'
import { showAgentLinkNotice, useLinkToAgent } from '../agentLink/linkToAgent'
import { paletteEvents } from '../palette/paletteEvents'
import { findTaskInProject, taskTabs } from '../../shared/streams'

interface Props {
  tabId: string
  visible: boolean
  filePath: string
  projectDir: string
  projectId: string
  taskId: string
  effectiveTheme: 'dark' | 'light'
}

/** True when at least one code cell has outputs or an execution count to clear. */
function notebookHasOutputs(doc: NotebookDocument | null): boolean {
  if (!doc) return false
  return doc.cells.some(
    (cell) => cell.cellType === 'code' && (cell.outputs.length > 0 || cell.executionCount != null)
  )
}

export default function NotebookTab({
  tabId,
  visible,
  filePath,
  projectDir,
  projectId,
  taskId,
  effectiveTheme
}: Props): React.ReactElement {
  const { config, projects } = useApp()
  const dirtyBuffers = useDirtyBufferStore()
  const monacoConfig = config ?? DEFAULT_CONFIG
  const projectRecord = projects.find((item) => item.id === projectId)
  const taskRecord = findTaskInProject(projectRecord, taskId)
  const projectConda: ProjectCondaSelection = {
    condaEnvName: projectRecord?.condaEnvName,
    condaEnvPrefix: projectRecord?.condaEnvPrefix
  }

  const [doc, setDoc] = useState<NotebookDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [kernelStatus, setKernelStatus] = useState<NotebookKernelStatus>('starting')
  const [kernelError, setKernelError] = useState<string | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [activeCellId, setActiveCellId] = useState<string | null>(null)
  const [editingMarkdownId, setEditingMarkdownId] = useState<string | null>(null)
  const [everVisible, setEverVisible] = useState(visible)
  const [loadGeneration, setLoadGeneration] = useState(0)
  const [kernelBootReady, setKernelBootReady] = useState(false)
  const [condaEnvs, setCondaEnvs] = useState<CondaEnvInfo[]>([])
  const [condaListError, setCondaListError] = useState<string | null>(null)
  const [suspendEditors, setSuspendEditors] = useState(false)
  const [editorEpoch, setEditorEpoch] = useState(0)

  const docRef = useRef<NotebookDocument | null>(null)
  const savedRef = useRef<string | null>(null)
  // The file as last read from or written to disk. Differs from `savedRef` (our
  // own serialization) for notebooks written without cell ids: those get stand-in
  // ids when parsed, which an agent reading the file will not find.
  const diskIdsRef = useRef<Set<string>>(new Set())
  // The cell editor that is mounted (only the active cell has one), for the
  // palette's "Link Selection to Agent", which does not go through Monaco.
  const cellEditorRef = useRef<{ cellId: string; editor: editor.IStandaloneCodeEditor } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dirtyRef = useRef(false)
  const requestIdRef = useRef(0)
  const executeSeqRef = useRef(0)
  const runStateRef = useRef<NotebookRunQueueState>(idleRunQueue())
  const kernelStatusRef = useRef<NotebookKernelStatus>('starting')
  const condaOverrideRef = useRef<ProjectCondaSelection | null>(null)
  const cancelEditorResumeRef = useRef<(() => void) | null>(null)

  const markDirty = useCallback((next: NotebookDocument) => {
    docRef.current = next
    const serialized = serializeNotebook(next)
    const isDirty = savedRef.current !== null && serialized !== savedRef.current
    dirtyRef.current = isDirty
    setDirty(isDirty)
    setDoc(next)
  }, [])

  const cancelEditorResume = useCallback(() => {
    cancelEditorResumeRef.current?.()
    cancelEditorResumeRef.current = null
  }, [])

  useEffect(() => () => cancelEditorResume(), [cancelEditorResume])

  /**
   * Unmount every Monaco host, commit that tree, then run `mutate`.
   * monaco-react's InstantiationService dies if <Editor> is still mounted
   * while the cell list is spliced (move/add/delete).
   */
  const withEditorsSuspended = useCallback((mutate: () => string | null) => {
    cancelEditorResume()
    flushSync(() => {
      setSuspendEditors(true)
      setActiveCellId(null)
    })
    const focusId = mutate()
    cancelEditorResumeRef.current = scheduleResumeAfterNotebookReorder(() => {
      cancelEditorResumeRef.current = null
      setSuspendEditors(false)
      setEditorEpoch((n) => n + 1)
      if (focusId) setActiveCellId(focusId)
    })
  }, [cancelEditorResume])

  const refreshContent = useCallback((force = false) => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    window.api.fbReadFile(projectDir, filePath, projectId).then((text) => {
      if (requestId !== requestIdRef.current) return
      if (!force && dirtyRef.current) return
      try {
        const parsed = parseNotebook(text)
        const serialized = serializeNotebook(parsed)
        if (!force && savedRef.current !== null && serialized === savedRef.current) return
        savedRef.current = serialized
        diskIdsRef.current = storedCellIds(text)
        docRef.current = parsed
        dirtyRef.current = false
        setDirty(false)
        setError(null)
        setDoc(parsed)
        setLoadGeneration((n) => n + 1)
        setActiveCellId((current) => current ?? parsed.cells[0]?.id ?? null)
        condaOverrideRef.current = notebookCondaEnvFromMetadata(parsed.metadata)
        setKernelBootReady(true)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setDoc(null)
        condaOverrideRef.current = null
        setKernelBootReady(true)
      }
    }).catch(() => {
      if (requestId !== requestIdRef.current) return
      if (!force && dirtyRef.current) return
      setError('Unable to read file.')
      setDoc(null)
      condaOverrideRef.current = null
      setKernelBootReady(true)
    })
  }, [filePath, projectDir, projectId])

  useEffect(() => {
    setDoc(null)
    setError(null)
    setSaveError(null)
    savedRef.current = null
    docRef.current = null
    dirtyRef.current = false
    setDirty(false)
    condaOverrideRef.current = null
    setKernelBootReady(false)
    refreshContent(true)
    return () => {
      requestIdRef.current += 1
    }
  }, [refreshContent])

  useEffect(() => {
    if (!visible) return
    refreshContent()
    const intervalId = window.setInterval(() => refreshContent(), FILE_BROWSER_REFRESH_MS)
    const handleFocus = () => refreshContent()
    const handleReload = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (detail?.tabId && detail.tabId !== tabId) return
      refreshContent(true)
    }
    window.addEventListener('focus', handleFocus)
    window.addEventListener('reload-file-tab', handleReload)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('reload-file-tab', handleReload)
    }
  }, [refreshContent, tabId, visible])

  useEffect(() => {
    if (visible) setEverVisible(true)
  }, [visible])

  const writeBuffer = useCallback((): Promise<void> => {
    const current = docRef.current
    if (!current) return Promise.resolve()
    const value = serializeNotebook(current)
    setSaveError(null)
    return window.api.fbWriteFile(projectDir, filePath, value, projectId).then(() => {
      savedRef.current = value
      diskIdsRef.current = storedCellIds(value)
      dirtyRef.current = serializeNotebook(docRef.current ?? current) !== value
      setDirty(dirtyRef.current)
      setSaveError(null)
      window.dispatchEvent(new CustomEvent('file-saved', { detail: { filePath, projectDir } }))
    }, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      setSaveError(message ? `Save failed: ${message}` : 'Save failed.')
      throw err
    })
  }, [filePath, projectDir, projectId])

  const saveContent = useCallback(() => {
    void writeBuffer().catch(() => {})
  }, [writeBuffer])

  const writeBufferRef = useRef(writeBuffer)
  useEffect(() => {
    writeBufferRef.current = writeBuffer
  }, [writeBuffer])

  useEffect(() => {
    const token = dirtyBuffers.registerBuffer(tabId, {
      filePath,
      isDirty: dirty,
      save: () => writeBufferRef.current()
    })
    return () => dirtyBuffers.unregisterBuffer(tabId, token)
  }, [dirtyBuffers, tabId, filePath, dirty])

  useEffect(() => {
    if (!visible) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveContent()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, saveContent])

  // Ctrl+L links the cell (or the selection inside it), Ctrl+Shift+L the notebook.
  // Unsaved changes are saved first — the agent reads the file. A cell is named by
  // its position, plus its id only when the file on disk stores that id.
  const linkToAgent = useLinkToAgent(projectId, taskId)
  const linkNotebook = useCallback((
    kind: 'selection' | 'file',
    cellId: string | null,
    lines: { startLine: number; endLine: number } | null
  ) => {
    void (async () => {
      if (dirtyRef.current) {
        try {
          await writeBuffer()
        } catch {
          showAgentLinkNotice('Save failed, so no link was sent.')
          return
        }
      }
      const path = agentLinkPath(projectDir, filePath)
      const index = cellId ? (docRef.current?.cells.findIndex((c) => c.id === cellId) ?? -1) : -1
      if (kind === 'file' || index < 0) {
        linkToAgent(formatAgentLink({ path }))
        return
      }
      const idOnDisk = cellId !== null && diskIdsRef.current.has(cellId)
      linkToAgent(formatAgentLink({
        path,
        cellNumber: index + 1,
        ...(idOnDisk && cellId ? { cellId } : {}),
        ...(lines ?? {})
      }))
    })()
  }, [filePath, linkToAgent, projectDir, writeBuffer])

  const activeCellIdRef = useRef<string | null>(null)
  activeCellIdRef.current = activeCellId
  const linkNotebookRef = useRef(linkNotebook)
  linkNotebookRef.current = linkNotebook

  // The active cell, with the lines selected in its editor when it has a selection.
  const activeCellSelection = (): { cellId: string | null; lines: { startLine: number; endLine: number } | null } => {
    const cellId = activeCellIdRef.current
    const mounted = cellEditorRef.current
    if (!cellId || mounted?.cellId !== cellId) return { cellId, lines: null }
    const sel = mounted.editor.getSelection()
    const empty = !sel || (sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn)
    return { cellId, lines: empty ? null : selectionLines(sel) }
  }

  // With a cell editor focused, its Monaco action handles the keys. Otherwise
  // (an idle cell was clicked, or the toolbar) link the active cell / notebook —
  // but only when focus is inside this notebook, so Ctrl+L still reaches a
  // terminal in the other pane.
  useEffect(() => {
    if (!visible) return
    const onKey = (event: KeyboardEvent) => {
      const kind = agentLinkShortcut(event, shortcutPlatform())
      if (!kind) return
      const target = event.target instanceof Element ? event.target : null
      if (!target || !rootRef.current?.contains(target)) return
      if (target.closest('.monaco-editor') || target.closest('input, textarea, select')) return
      event.preventDefault()
      event.stopPropagation()
      linkNotebookRef.current(kind, activeCellIdRef.current, null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible])

  // From the palette: only when this notebook had focus when the palette opened.
  useEffect(() => {
    if (!visible) return
    return paletteEvents.on('link-to-agent', (request) => {
      if (request.handled || !request.target || !rootRef.current?.contains(request.target)) return
      request.handled = true
      const { cellId, lines } = activeCellSelection()
      linkNotebookRef.current(request.kind, cellId, lines)
    })
  }, [visible])

  const startKernel = useCallback(() => {
    setKernelError(null)
    setKernelStatus('starting')
    kernelStatusRef.current = 'starting'
    const override = notebookCondaOverridePayload(condaOverrideRef.current)
    void window.api.notebookKernelStart(tabId, projectId, projectDir, override).then((result) => {
      if (result?.error) {
        setKernelError(result.error)
        setKernelStatus('error')
        kernelStatusRef.current = 'error'
      }
    })
  }, [projectDir, projectId, tabId])

  useEffect(() => {
    if (!everVisible || !kernelBootReady) return
    startKernel()
    return () => {
      void window.api.notebookKernelShutdown(tabId)
    }
  }, [startKernel, tabId, everVisible, kernelBootReady])

  useEffect(() => {
    if (!everVisible) return
    let cancelled = false
    window.api.condaListEnvs(projectId).then((result) => {
      if (cancelled) return
      setCondaEnvs(result.envs)
      if (result.error && result.envs.length === 0) setCondaListError(result.error)
      else setCondaListError(null)
    }).catch((err: unknown) => {
      if (!cancelled) setCondaListError(err instanceof Error ? err.message : 'Failed to list conda envs')
    })
    return () => { cancelled = true }
  }, [everVisible, projectId])

  const clearRunQueue = useCallback(() => {
    runStateRef.current = idleRunQueue()
    setRunningIds(new Set())
  }, [])

  const sendExecute = useCallback((cellId: string) => {
    const current = docRef.current
    const cell = current?.cells.find((item) => item.id === cellId)
    if (!current || !cell || cell.cellType !== 'code') {
      const { state, next } = completeRun(runStateRef.current, cellId)
      runStateRef.current = state
      if (next) sendExecute(next)
      return
    }
    if (kernelStatusRef.current === 'error' || kernelStatusRef.current === 'dead') {
      setKernelError((prev) => prev ?? 'Kernel is not running. Click Restart kernel.')
      clearRunQueue()
      return
    }
    markDirty(replaceCellOutputs(current, cellId, [], cell.executionCount))
    setRunningIds((prev) => new Set(prev).add(cellId))
    executeSeqRef.current += 1
    const requestId = makeExecuteRequestId(cellId, executeSeqRef.current)
    void window.api.notebookKernelExecute(tabId, requestId, cell.source, cellId).then((result) => {
      if (!result?.error) return
      setKernelError(result.error)
      setRunningIds((prev) => {
        const next = new Set(prev)
        next.delete(cellId)
        return next
      })
      if (/not running/i.test(result.error)) {
        clearRunQueue()
        return
      }
      const finished = completeRun(runStateRef.current, cellId)
      runStateRef.current = finished.state
      if (finished.next) sendExecute(finished.next)
    })
  }, [clearRunQueue, markDirty, tabId])

  const requestSingleRun = useCallback((cellId: string) => {
    const previous = runStateRef.current
    const nextState = beginSingleRun(previous, cellId)
    runStateRef.current = nextState
    // Only dispatch when this cell is the one that just became in-flight.
    // A mid-flight Run is appended; it must not wipe Run-all.
    if (!previous.inFlight && nextState.inFlight === cellId) {
      sendExecute(cellId)
    }
  }, [sendExecute])

  useEffect(() => {
    const unsubscribe = window.api.onNotebookKernelEvent((id, event) => {
      if (id !== tabId) return
      if (event.event === 'status') {
        const next = event.execution_state === 'dead' ? 'dead' : event.execution_state
        kernelStatusRef.current = next
        setKernelStatus(next)
        return
      }
      if (event.event === 'ready') {
        kernelStatusRef.current = 'idle'
        setKernelStatus('idle')
        setKernelError(null)
        return
      }
      if (event.event === 'fail') {
        kernelStatusRef.current = 'error'
        setKernelStatus('error')
        setKernelError(event.message)
        clearRunQueue()
        return
      }
      if (event.event === 'dead') {
        kernelStatusRef.current = 'dead'
        setKernelStatus('dead')
        if (event.message) setKernelError(event.message)
        clearRunQueue()
        return
      }
      const cellId = 'id' in event ? cellIdFromRequestId(event.id, event.cellId) : null
      if (event.event === 'execute_reply') {
        const current = docRef.current
        if (cellId && current && typeof event.execution_count === 'number') {
          const cell = current.cells.find((item) => item.id === cellId)
          if (cell) {
            markDirty(replaceCellOutputs(current, cellId, cell.outputs, event.execution_count))
          }
        }
        if (cellId) {
          setRunningIds((prev) => {
            const next = new Set(prev)
            next.delete(cellId)
            return next
          })
          const finished = completeRun(runStateRef.current, cellId)
          runStateRef.current = finished.state
          if (finished.next) sendExecute(finished.next)
        }
        return
      }
      if (!cellId) return
      const current = docRef.current
      const cell = current?.cells.find((item) => item.id === cellId)
      if (!current || !cell) return
      const nextOutputs = applyKernelEventToOutputs(cell.outputs, event)
      if (nextOutputs) markDirty(replaceCellOutputs(current, cellId, nextOutputs))
    })
    return unsubscribe
  }, [clearRunQueue, markDirty, sendExecute, tabId])

  const runActive = useCallback(() => {
    const current = docRef.current
    if (!current) return
    const cell = current.cells.find((item) => item.id === activeCellId) ?? current.cells[0]
    if (!cell) return
    if (cell.cellType === 'markdown') {
      setEditingMarkdownId(null)
      return
    }
    if (cell.cellType === 'raw') return
    requestSingleRun(cell.id)
  }, [activeCellId, requestSingleRun])

  const runAndNext = useCallback(() => {
    const current = docRef.current
    if (!current) return
    const index = current.cells.findIndex((item) => item.id === activeCellId)
    const cell = index >= 0 ? current.cells[index] : current.cells[0]
    if (!cell) return
    if (cell.cellType === 'markdown') {
      setEditingMarkdownId(null)
    } else if (cell.cellType === 'code') {
      requestSingleRun(cell.id)
    }
    const latest = docRef.current ?? current
    const next = latest.cells[index + 1]
    if (next) {
      setActiveCellId(next.id)
      if (next.cellType === 'markdown') setEditingMarkdownId(next.id)
    } else {
      const withNew = addCellAt(latest, latest.cells.length, 'code')
      const created = withNew.cells[withNew.cells.length - 1]
      markDirty(withNew)
      setActiveCellId(created.id)
    }
  }, [activeCellId, markDirty, requestSingleRun])

  const startRunAll = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    // Do not replace an in-flight Run / Run-all; that would double-send the first cell.
    if (runStateRef.current.inFlight || runStateRef.current.queued.length > 0) return
    const nextState = beginRunAll(ids)
    runStateRef.current = nextState
    if (nextState.inFlight) sendExecute(nextState.inFlight)
  }, [sendExecute])

  const runAll = useCallback(() => {
    const current = docRef.current
    if (!current) return
    startRunAll(current.cells.filter((cell) => cell.cellType === 'code').map((cell) => cell.id))
  }, [startRunAll])

  const runAbove = useCallback((cellId: string) => {
    const current = docRef.current
    if (!current) return
    const index = current.cells.findIndex((cell) => cell.id === cellId)
    startRunAll(codeCellIdsAbove(current.cells, index))
  }, [startRunAll])

  const restartKernel = useCallback(() => {
    clearRunQueue()
    setKernelError(null)
    setKernelStatus('starting')
    kernelStatusRef.current = 'starting'
    const override = notebookCondaOverridePayload(condaOverrideRef.current)
    void window.api.notebookKernelRestart(tabId, projectId, projectDir, override).then((result) => {
      if (result?.error) {
        setKernelError(result.error)
        setKernelStatus('error')
        kernelStatusRef.current = 'error'
      }
    })
  }, [clearRunQueue, projectDir, projectId, tabId])

  const interruptKernel = useCallback(() => {
    clearRunQueue()
    void window.api.notebookKernelInterrupt(tabId)
  }, [clearRunQueue, tabId])

  const condaPlatform = window.api?.platform ?? ''
  const condaOverride = notebookCondaEnvFromMetadata(doc?.metadata)
  const effectiveConda = notebookKernelCondaSelection(condaOverride, projectConda)
  const condaValue = condaOverride
    ? condaSelectValue(condaOverride, condaEnvs, condaPlatform)
    : ''
  const envLabel =
    effectiveConda.condaEnvName?.trim()
    || lastPathSegment(effectiveConda.condaEnvPrefix ?? '')
    || null
  const projectEnvLabel =
    projectConda.condaEnvName?.trim()
    || lastPathSegment(projectConda.condaEnvPrefix ?? '')
    || null

  const onCondaChange = useCallback((value: string) => {
    const current = docRef.current
    if (!current) return
    const selected = value
      ? condaEnvFromSelection(value, condaEnvs)
      : null
    condaOverrideRef.current = selected
    markDirty(setNotebookCondaEnvMetadata(current, selected))
    restartKernel()
  }, [condaEnvs, markDirty, restartKernel])

  // Document-only: wipe cell outputs and execution counts. Kernel stays up.
  const clearOutputs = useCallback(() => {
    const current = docRef.current
    if (!current || !notebookHasOutputs(current)) return
    markDirty(clearAllOutputs(current))
  }, [markDirty])

  if (!visible && !everVisible) return <div style={{ display: 'none' }} />

  const statusColor =
    kernelStatus === 'busy' || kernelStatus === 'starting'
      ? 'var(--color-warn)'
      : kernelStatus === 'dead' || kernelStatus === 'error'
        ? 'var(--color-danger)'
        : 'var(--color-success)'
  const usingOverride = Boolean(condaOverride)
  const projectDefaultOptionLabel = notebookProjectDefaultOptionLabel(projectEnvLabel)
  const envControlLabel = notebookKernelEnvControlLabel(usingOverride, envLabel, projectEnvLabel)
  const envControlTitle = notebookKernelEnvControlTitle(kernelStatus, envControlLabel)
  const envControlHint = condaListError ? `${envControlTitle} ${condaListError}` : envControlTitle
  const runQueueBusy = notebookRunQueueBusy(runningIds.size)

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="outline-none"
      style={{ position: 'absolute', inset: 0, display: visible ? 'flex' : 'none', flexDirection: 'column' }}
    >
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-hair bg-surface-2 shrink-0">
        <button
          type="button"
          className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs hover:bg-surface-3 hover:text-text disabled:opacity-40"
          onClick={runActive}
          title={`Run cell (${formatShortcutForApp('CmdOrCtrl+Enter')})`}
        >
          <span className="inline-flex items-center gap-1"><Play size={12} /> Run</span>
        </button>
        <button
          type="button"
          className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs hover:bg-surface-3 hover:text-text disabled:opacity-40"
          onClick={runAll}
          disabled={!notebookRunAllEnabled(runQueueBusy)}
          title={notebookRunAllTitle(runQueueBusy)}
        >
          Run all
        </button>
        <button
          type="button"
          className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs hover:bg-surface-3 hover:text-text"
          onClick={restartKernel}
          title="Restart kernel"
        >
          <span className="inline-flex items-center gap-1"><RotateCw size={12} /> Restart</span>
        </button>
        <button
          type="button"
          className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs hover:bg-surface-3 hover:text-text disabled:opacity-40"
          onClick={interruptKernel}
          disabled={kernelStatus !== 'busy'}
          title="Interrupt kernel"
        >
          <span className="inline-flex items-center gap-1"><Square size={12} /> Interrupt</span>
        </button>
        <button
          type="button"
          className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs hover:bg-surface-3 hover:text-text disabled:opacity-40"
          onClick={clearOutputs}
          disabled={!notebookHasOutputs(doc)}
          title="Clear all cell outputs"
        >
          <span className="inline-flex items-center gap-1"><Eraser size={12} /> Clear outputs</span>
        </button>
        <ThemedSelect
          className="ml-2 max-w-[18rem] min-w-[8rem] shrink-0"
          size="sm"
          value={condaValue}
          disabled={!doc}
          aria-label={envControlTitle}
          title={envControlHint}
          onChange={onCondaChange}
          leading={(
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: statusColor }}
              aria-hidden
            />
          )}
          options={[
            { value: '', label: projectDefaultOptionLabel },
            ...(condaSavedOptionVisible(condaValue, condaEnvs)
              ? [{
                  value: condaValue,
                  label: condaSavedOptionLabel(
                    condaValue,
                    condaOverride?.condaEnvName ?? envLabel ?? undefined
                  )
                }]
              : []),
            ...condaEnvs.map((env) => ({ value: env.prefix, label: env.name }))
          ]}
        />
        <span className="ml-2 flex min-w-0 flex-1 items-center justify-end gap-1.5">
          <button
            type="button"
            className="bg-transparent border-0 text-text-muted cursor-pointer px-1.5 py-1 rounded-md text-xs hover:bg-surface-3 hover:text-text"
            onClick={() => linkNotebook('file', null, null)}
            title={`Link notebook to agent (${formatShortcutForApp('CmdOrCtrl+Shift+L')})`}
          >
            <AtSign size={12} />
          </button>
          <span className="min-w-0 truncate text-2xs text-text-subtle" title={filePath}>{filePath}</span>
          <span
            title={dirty ? 'Unsaved changes' : undefined}
            className="w-2 h-2 shrink-0 rounded-full"
            style={{ background: dirty ? 'var(--color-accent)' : 'transparent' }}
            aria-hidden={!dirty}
          />
        </span>
      </div>

      {kernelError && (
        <div role="alert" className="px-3 py-2 text-sm border-b border-hair" style={{ color: 'var(--color-danger)' }}>
          {kernelError}
        </div>
      )}

      {doc === null ? (
        <div className="tab-content-placeholder">{error ?? 'Loading...'}</div>
      ) : (
        <div className="flex-1 overflow-y-auto py-2">
          {doc.cells.map((cell, index) => (
            <NotebookCellView
              key={cell.id}
              cell={cell}
              index={index}
              cellCount={doc.cells.length}
              isActive={cell.id === activeCellId}
              isEditingMarkdown={editingMarkdownId === cell.id}
              isRunning={runningIds.has(cell.id)}
              config={monacoConfig}
              effectiveTheme={effectiveTheme}
              suspendEditors={suspendEditors}
              onFocus={() => setActiveCellId(cell.id)}
              onLinkToAgent={(kind, lines) => linkNotebook(kind, cell.id, lines)}
              agentAvailable={!!taskRecord && taskTabs(taskRecord).some((t) => isAgentTabType(t.type))}
              onEditorChange={(ed) => {
                if (ed) cellEditorRef.current = { cellId: cell.id, editor: ed }
                else if (cellEditorRef.current?.cellId === cell.id) cellEditorRef.current = null
              }}
              onChangeSource={(source) => {
                const current = docRef.current
                if (!current) return
                markDirty(updateCellSource(current, cell.id, source))
              }}
              onRun={() => {
                setActiveCellId(cell.id)
                if (cell.cellType === 'markdown') {
                  setEditingMarkdownId(null)
                  return
                }
                requestSingleRun(cell.id)
              }}
              onRunAbove={() => runAbove(cell.id)}
              canRunAbove={notebookRunAboveEnabled(
                runQueueBusy,
                codeCellIdsAbove(doc.cells, index).length > 0
              )}
              runAboveTitle={notebookRunAboveTitle(runQueueBusy)}
              onRunAndNext={runAndNext}
              onChangeType={(type: NotebookCellType) => {
                const current = docRef.current
                if (!current) return
                markDirty(changeCellTypeAt(current, index, type))
              }}
              onAddBelow={() => {
                const current = docRef.current
                if (!current) return
                withEditorsSuspended(() => {
                  const next = addCellAt(current, index + 1, 'code')
                  markDirty(next)
                  return next.cells[index + 1]?.id ?? null
                })
              }}
              onDelete={() => {
                const current = docRef.current
                if (!current) return
                withEditorsSuspended(() => {
                  const next = deleteCellAt(current, index)
                  markDirty(next)
                  return next.cells[Math.min(index, next.cells.length - 1)]?.id ?? null
                })
              }}
              onMove={(direction) => {
                const current = docRef.current
                if (!current) return
                const next = moveCellById(current, cell.id, direction)
                if (next === current) return
                withEditorsSuspended(() => {
                  markDirty(next)
                  return cell.id
                })
              }}
              onStartMarkdownEdit={() => {
                setActiveCellId(cell.id)
                setEditingMarkdownId(cell.id)
              }}
              onFinishMarkdownEdit={() => setEditingMarkdownId(null)}
              onToggleCollapsed={() => {
                const current = docRef.current
                if (!current) return
                const live = current.cells.find((item) => item.id === cell.id)
                if (!live) return
                markDirty(setNotebookCellCollapsed(current, live.id, !isNotebookCellCollapsed(live)))
              }}
              resetKey={loadGeneration + editorEpoch}
            />
          ))}
        </div>
      )}

      {saveError !== null && (
        <div
          role="alert"
          className="absolute bottom-2 left-2 right-2 z-(--z-sticky) flex items-center gap-2 bg-surface border border-border rounded-md px-2 py-1 text-sm leading-snug"
          style={{ color: 'var(--color-danger)' }}
        >
          <span className="flex-1 truncate" title={saveError}>{saveError}</span>
          <button className="text-accent cursor-pointer hover:underline" onClick={saveContent}>Retry</button>
          <button className="text-accent cursor-pointer hover:underline" onClick={() => setSaveError(null)}>Dismiss</button>
        </div>
      )}
    </div>
  )
}

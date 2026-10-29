import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { useApp } from '../context/AppContext'
import { findStreamRunCommand, streamRunCommands, streamRunTabId, streamRunTask } from '../../shared/stream-run'
import { buildXtermTheme } from './terminalThemes'
import { sanitizeRestoredScrollback } from './scrollbackReplay'
import { bindCopyOnSelect } from './copyOnSelect'
import { WEB_LINK_REGEX } from '../utils/terminalLinkAt'
import { controlStreamRun, openStreamRunLogs, useStreamRun, useStreamRuns, type StreamRunLogsTarget } from '../streamRuns'
import { StreamRunButtons, StreamRunStatusLabel } from './StreamRunControls'

/**
 * One command's run log: the run's own PTY, shown like a terminal (typing
 * reaches the app, e.g. a dev server's shortcut keys). Closing it leaves the
 * command running. A restart starts the view over with the new run's output.
 * The stream's other commands are a click away in the header.
 */
export default function StreamRunLogs({ projectId, streamId, commandId }: StreamRunLogsTarget): React.ReactElement | null {
  const { projects, config, effectiveTerminalTheme, terminalZoomDelta } = useApp()
  const project = projects.find(p => p.id === projectId)
  const stream = project?.streams.find(s => s.id === streamId)
  const run = useStreamRun(projectId, streamId, commandId)
  const streamRuns = useStreamRuns(projectId, streamId)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null)
  const [empty, setEmpty] = useState(false)
  const tabId = streamRunTabId(streamId, commandId)
  const close = () => openStreamRunLogs(null)

  // The stream went away (closed, deleted): nothing left to show.
  useEffect(() => {
    if (!stream) close()
  }, [stream])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // One xterm for the view's lifetime.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !config) return
    const term = new Terminal({
      fontFamily: config.fontFamily,
      fontSize: config.fontSize + terminalZoomDelta,
      theme: buildXtermTheme(effectiveTerminalTheme, config.terminalColorScheme),
      allowProposedApi: true,
      cursorBlink: false,
      scrollback: 10_000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((event, uri) => {
      if (event.button !== 0) return
      event.preventDefault()
      void window.api.openExternal(uri)
    }, { urlRegex: WEB_LINK_REGEX }))
    const unicode11 = new Unicode11Addon()
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'
    term.open(host)
    const copyBinding = config.copyOnSelect ? bindCopyOnSelect(term) : null
    termRef.current = { term, fit }
    const input = term.onData((data) => window.api.ptyWrite(tabId, data))
    const resize = term.onResize(({ cols, rows }) => window.api.ptyResize(tabId, cols, rows))
    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit()
    })
    observer.observe(host)
    term.focus()
    return () => {
      observer.disconnect()
      input.dispose()
      resize.dispose()
      copyBinding?.dispose()
      termRef.current = null
      term.dispose()
    }
  }, [config, effectiveTerminalTheme, terminalZoomDelta, tabId])

  // Attach to the run, again for each new run (Restart, or Run after it ended).
  const startedAt = run?.startedAt
  useEffect(() => {
    const current = termRef.current
    if (!current) return
    const { term, fit } = current
    let attached = false
    let cancelled = false
    // Output already in the attach's scrollback must not be written twice: drop
    // pushes until the answer, which comes after every push it includes.
    const unsubscribe = window.api.subscribePtyData((id, data) => {
      if (id === tabId && attached) term.write(data)
    })
    term.reset()
    void window.api.streamRunAttach(projectId, tabId).then((result) => {
      if (cancelled) return
      attached = true
      setEmpty(!result || (!result.scrollback && result.exitCode !== null))
      if (!result) return
      const restored = sanitizeRestoredScrollback(result.scrollback)
      if (restored) term.write(restored, () => term.scrollToBottom())
      fit.fit()
      window.api.ptyResize(tabId, term.cols, term.rows)
    }).catch(() => { if (!cancelled) setEmpty(true) })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [projectId, tabId, startedAt, config, effectiveTerminalTheme, terminalZoomDelta])

  useEffect(() => () => window.api.streamRunDetach(tabId), [tabId])

  if (!project || !stream) return null
  const defined = findStreamRunCommand(project, stream, commandId)
  const command = run?.command ?? defined?.command
  const name = run?.name ?? defined?.name ?? 'Command'
  // Every command of the stream, and any that ran since it was removed.
  const others = [
    ...streamRunCommands(project, stream).map(c => ({ id: c.id, name: c.name })),
    ...streamRuns.filter(r => !findStreamRunCommand(project, stream, r.commandId)).map(r => ({ id: r.commandId, name: r.name }))
  ]
  // Run again where the shown run was: its task's worktree, if it's still open.
  const runTask = streamRunTask(stream, run)
  const termBackground = config ? buildXtermTheme(effectiveTerminalTheme, config.terminalColorScheme).background : undefined

  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center bg-black/50" onClick={close}>
      <div
        className="w-[min(1100px,92vw)] h-[78vh] rounded-xl border border-border bg-surface shadow-pop flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="stream-run-logs"
      >
        <header className="flex items-center gap-3 px-4 h-(--ctl-h-lg) mt-1 shrink-0">
          <h2 className="text-md font-semibold text-text m-0 whitespace-nowrap">
            {project.name}
            {!stream.isMain && <span className="text-text-muted font-normal font-mono"> · {stream.name}</span>}
          </h2>
          <span className="text-sm text-text whitespace-nowrap" data-testid="stream-run-logs-name">{name}</span>
          <StreamRunStatusLabel run={run} taskName={runTask?.name} />
          <span className="ml-auto flex items-center gap-1">
            <StreamRunButtons
              run={run}
              canRun={!!defined}
              onAction={(action) => void controlStreamRun(projectId, streamId, commandId, action, action === 'stop' ? undefined : runTask?.id)}
              size="md"
            />
          </span>
          <button
            onClick={close}
            className="bg-transparent border-0 text-text-muted cursor-pointer text-lg leading-none px-1 rounded-sm hover:text-text"
            title="Close (the app keeps running)"
          >
            &times;
          </button>
        </header>
        {others.length > 1 && (
          <div className="flex items-center gap-1 px-3 pb-1.5 shrink-0 overflow-x-auto" data-testid="stream-run-logs-commands">
            {others.map(other => {
              const otherRun = streamRuns.find(r => r.commandId === other.id)
              return (
                <button
                  key={other.id}
                  type="button"
                  onClick={() => openStreamRunLogs({ projectId, streamId, commandId: other.id })}
                  className={[
                    'flex items-center gap-1.5 h-(--ctl-h-sm) px-2 rounded-md border-0 cursor-pointer text-xs whitespace-nowrap',
                    other.id === commandId ? 'bg-sel text-text' : 'bg-transparent text-text-muted hover:text-text hover:bg-sel'
                  ].join(' ')}
                >
                  {otherRun?.status === 'running' && <span className="size-1.5 rounded-full bg-success" />}
                  {other.name}
                </button>
              )
            })}
          </div>
        )}
        <div className="px-4 pb-2 text-xs font-mono text-text-subtle overflow-hidden text-ellipsis whitespace-nowrap shrink-0" title={command}>
          {command ? `$ ${command}` : 'This command is no longer set: add it in Project settings, or in the stream\'s commands.'}
        </div>
        <div className="relative flex-1 min-h-0 mx-3 mb-3 rounded-md overflow-hidden" style={{ background: termBackground }}>
          <div ref={hostRef} className="absolute inset-0 p-2" />
          {empty && !run && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted pointer-events-none">
              Not run yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { useApp } from '../context/AppContext'
import { streamRunCommand, streamRunTabId } from '../../shared/stream-run'
import { buildXtermTheme } from './terminalThemes'
import { sanitizeRestoredScrollback } from './scrollbackReplay'
import { bindCopyOnSelect } from './copyOnSelect'
import { WEB_LINK_REGEX } from '../utils/terminalLinkAt'
import { controlStreamRun, openStreamRunLogs, useStreamRun, type StreamRunLogsTarget } from '../streamRuns'
import { StreamRunButtons, StreamRunStatusLabel } from './StreamRunControls'

/**
 * A stream's app run log: the run's own PTY, shown like a terminal (typing
 * reaches the app, e.g. a dev server's shortcut keys). Closing it leaves the
 * app running. A restart starts the view over with the new run's output.
 */
export default function StreamRunLogs({ projectId, streamId }: StreamRunLogsTarget): React.ReactElement | null {
  const { projects, config, effectiveTerminalTheme, terminalZoomDelta } = useApp()
  const project = projects.find(p => p.id === projectId)
  const stream = project?.streams.find(s => s.id === streamId)
  const run = useStreamRun(projectId, streamId)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null)
  const [empty, setEmpty] = useState(false)
  const tabId = streamRunTabId(streamId)
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
  const command = run?.command ?? streamRunCommand(project, stream)
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
          <StreamRunStatusLabel run={run} />
          <span className="ml-auto flex items-center gap-1">
            <StreamRunButtons
              run={run}
              canRun={!!command}
              onAction={(action) => void controlStreamRun(projectId, streamId, action)}
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
        <div className="px-4 pb-2 text-xs font-mono text-text-subtle overflow-hidden text-ellipsis whitespace-nowrap shrink-0" title={command}>
          {command ? `$ ${command}` : 'No run command: set one in Project settings, or on the stream.'}
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

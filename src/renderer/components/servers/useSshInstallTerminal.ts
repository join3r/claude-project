import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SshInstallExit, SshInstallTarget } from '../../../shared/servers'
import { useApp } from '../../context/AppContext'
import { buildXtermTheme } from '../terminalThemes'
import { disarmXtermDocMouseListeners } from '../xtermDisposal'
import { formatSshTarget } from './sshTargets'

/** What to run: a typed target, or an SSH project's machine (main takes its target and connection). */
export interface SshInstallRequest {
  target: SshInstallTarget
  projectId?: string
}

export interface SshInstallTerminal {
  /** Where the terminal goes; render it once `shown`. */
  hostRef: RefObject<HTMLDivElement | null>
  theme: ITheme
  /** An install was started: the terminal exists from then on. */
  shown: boolean
  /** ssh is running. */
  session: { id: string; target: string } | null
  /** How the last ssh ended. */
  ended: { exit: SshInstallExit; target: string } | null
  /** ssh could not start at all. */
  error: string | null
  start(request: SshInstallRequest): void
  stop(): void
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
}

/**
 * Install over SSH's terminal: the system ssh runs in a pty in main and shows
 * here, in a small xterm, where host key questions, passwords and 2FA codes
 * get answered. Main slips the install token in once the server is ready for
 * it; it never shows up here. Leaving (unmounting) stops ssh.
 */
export function useSshInstallTerminal(): SshInstallTerminal {
  const { config, effectiveTerminalTheme } = useApp()
  const [request, setRequest] = useState<SshInstallRequest | null>(null)
  const [session, setSession] = useState<{ id: string; target: string } | null>(null)
  const [ended, setEnded] = useState<{ exit: SshInstallExit; target: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null)
  const sessionRef = useRef<string | null>(null)
  const targetRef = useRef('')

  const scheme = config?.terminalColorScheme ?? 'auto'
  const theme = useMemo(() => buildXtermTheme(effectiveTerminalTheme, scheme), [effectiveTerminalTheme, scheme])
  // The terminal is made once; these are what it starts with.
  const initial = useRef({ theme, fontFamily: config?.fontFamily })

  // Output and the end of ssh, for this terminal's session only.
  useEffect(() => {
    const offData = window.api.onServersSshInstallData((id, data) => {
      if (id === sessionRef.current) termRef.current?.term.write(data)
    })
    const offExit = window.api.onServersSshInstallExit((id, exit) => {
      if (id !== sessionRef.current) return
      sessionRef.current = null
      setSession(null)
      setEnded({ exit, target: targetRef.current })
    })
    return () => { offData(); offExit() }
  }, [])

  // The terminal, made the first time an install starts.
  useEffect(() => {
    if (!shown || termRef.current || !hostRef.current) return
    const term = new Terminal({
      fontFamily: initial.current.fontFamily,
      fontSize: 12,
      theme: initial.current.theme,
      cursorBlink: true,
      scrollback: 2000,
      convertEol: false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    try { fit.fit() } catch { /* not laid out yet */ }
    term.onData((data) => {
      if (sessionRef.current) window.api.serversSshInstallInput(sessionRef.current, data)
    })
    termRef.current = { term, fit }
    const observer = new ResizeObserver(() => {
      try { fit.fit() } catch { return }
      if (sessionRef.current) window.api.serversSshInstallResize(sessionRef.current, term.cols, term.rows)
    })
    observer.observe(hostRef.current)
    return () => {
      observer.disconnect()
    }
  }, [shown])

  // Tear down: stop ssh and drop the terminal.
  useEffect(() => () => {
    if (sessionRef.current) void window.api.serversSshInstallStop(sessionRef.current).catch(() => {})
    sessionRef.current = null
    const current = termRef.current
    termRef.current = null
    if (current) {
      disarmXtermDocMouseListeners()
      current.term.dispose()
    }
  }, [])

  // Follow the theme.
  useEffect(() => {
    if (termRef.current) termRef.current.term.options.theme = theme
  }, [theme])

  // Start once the terminal is there.
  useEffect(() => {
    const current = termRef.current
    if (!request || !current) return
    const { target, projectId } = request
    current.term.reset()
    current.term.write(`\x1b[2m$ ssh ${formatSshTarget(target)}\x1b[0m\r\n`)
    let cancelled = false
    window.api.serversSshInstallStart(target, { cols: current.term.cols, rows: current.term.rows }, projectId ? { projectId } : undefined)
      .then((started) => {
        if (cancelled) { void window.api.serversSshInstallStop(started.sessionId).catch(() => {}); return }
        sessionRef.current = started.sessionId
        targetRef.current = started.target
        setSession({ id: started.sessionId, target: started.target })
        current.term.focus()
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err))
      })
    return () => { cancelled = true }
  }, [request])

  return {
    hostRef,
    theme,
    shown,
    session,
    ended,
    error,
    start: (next) => {
      setError(null)
      setEnded(null)
      setShown(true)
      setRequest({ ...next })
    },
    stop: () => {
      if (sessionRef.current) void window.api.serversSshInstallStop(sessionRef.current).catch(() => {})
    }
  }
}

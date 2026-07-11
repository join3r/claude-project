import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { ImageAddon } from '@xterm/addon-image'
import TerminalSearchBar from './TerminalSearchBar'
import { bindCopyOnSelect } from './copyOnSelect'
import { bindTransientScrollbar } from './transientScrollbar'
import { useApp } from '../context/AppContext'
import '@xterm/xterm/css/xterm.css'
import { DEFAULT_CONFIG, type SshConfig, type ShellCommandConfig } from '../../shared/types'
import { normalizeBrowserUrl } from '../browserUrl'
import LinkContextMenu, { type LinkMenuState } from './LinkContextMenu'
import { bindTerminalLinkContextMenu } from '../utils/bindTerminalLinkContextMenu'
import { WEB_LINK_REGEX } from '../utils/terminalLinkAt'
import { sanitizeRestoredScrollback } from './scrollbackReplay'
import { disarmXtermDocMouseListeners } from './xtermDisposal'
import { buildXtermTheme } from './terminalThemes'
import { useTabStatusStore } from '../context/TabStatusContext'
import { terminalStatusFromOutput } from './terminalStatus'

const ENABLE_XTERM_WEBGL = false

interface Props {
  tabId: string
  visible: boolean
  projectId: string
  taskId: string
  pane: 'left' | 'right'
  projectDir: string
  sshConfig?: SshConfig
  shellCommand?: ShellCommandConfig
}

interface TerminalEntry {
  term: Terminal
  fitAddon: FitAddon
  serializeAddon: SerializeAddon
  searchAddon: SearchAddon
  webglAddon: WebglAddon | null
  scrollbarBinding: { dispose(): void } | null
  linkContextMenuBinding: { dispose(): void } | null
  restoring: boolean
  pendingData: string[]
  suppressResizeEvents: number
}

const terminals = new Map<string, TerminalEntry>()
const statusDetectors = new Map<string, (chunk: string) => void>()
const exitListeners = new Map<string, () => void>()

let ptyListenerRegistered = false
let ptyExitListenerRegistered = false
let ptySizeListenerRegistered = false

function resizeTerminal(entry: TerminalEntry, cols: number, rows: number): void {
  if (entry.term.cols === cols && entry.term.rows === rows) return
  entry.suppressResizeEvents += 1
  try {
    entry.term.resize(cols, rows)
  } finally {
    entry.suppressResizeEvents = Math.max(0, entry.suppressResizeEvents - 1)
  }
}

function ensurePtyListener(): void {
  if (ptyListenerRegistered) return
  ptyListenerRegistered = true
  window.api.onPtyData((id: string, data: string) => {
    statusDetectors.get(id)?.(data)
    const entry = terminals.get(id)
    if (!entry) return
    if (entry.restoring) {
      entry.pendingData.push(data)
      return
    }
    entry.term.write(data)
  })
}

function ensurePtyExitListener(): void {
  if (ptyExitListenerRegistered) return
  ptyExitListenerRegistered = true
  window.api.onPtyExit((id: string) => {
    exitListeners.get(id)?.()
  })
}

function ensurePtySizeListener(): void {
  if (ptySizeListenerRegistered) return
  ptySizeListenerRegistered = true
  window.api.onPtySizeSync((id: string, cols: number, rows: number) => {
    const entry = terminals.get(id)
    if (!entry) return
    resizeTerminal(entry, cols, rows)
  })
}

let beforeUnloadRegistered = false
function ensureBeforeUnloadHandler(): void {
  if (beforeUnloadRegistered) return
  beforeUnloadRegistered = true
  window.addEventListener('beforeunload', () => {
    for (const [id, entry] of terminals) {
      try {
        const data = entry.serializeAddon.serialize()
        window.api.scrollbackSaveSync(id, data)
      } catch {
        // Terminal may already be disposed
      }
    }
  })
}

/** Try to attach a WebGL addon; dispose on context loss so xterm falls back to canvas. */
function attachWebgl(tabId: string, term: Terminal): WebglAddon | null {
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      try { addon.dispose() } catch { /* already gone */ }
      const entry = terminals.get(tabId)
      if (entry) entry.webglAddon = null
    })
    term.loadAddon(addon)
    return addon
  } catch {
    return null
  }
}

export default function TerminalTab({ tabId, visible, projectId, taskId, pane, projectDir, sshConfig, shellCommand }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const { addTab, config, effectiveTerminalTheme, terminalZoomDelta, markTaskInteracted } = useApp()
  const initializedRef = useRef(false)
  const spawnedRef = useRef(false)
  const focusClaimRef = useRef(false)
  const projectDirRef = useRef(projectDir)
  projectDirRef.current = projectDir
  const [sshReady, setSshReady] = useState(!sshConfig)
  const prevSshReadyRef = useRef(sshReady)
  const [searchOpen, setSearchOpen] = useState(false)
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null)

  const statusStore = useTabStatusStore()
  const lastStatusWriteRef = useRef(0)
  const decayTimerRef = useRef<number | null>(null)

  const handleOutputForStatus = useCallback((chunk: string) => {
    const now = Date.now()
    if (now - lastStatusWriteRef.current < 200) return // throttle ~5/sec
    lastStatusWriteRef.current = now

    const lines = chunk.split(/\r?\n/).filter(l => l.trim().length > 0)
    const lastLine = lines[lines.length - 1]
    if (!lastLine) return

    const prev = statusStore.getStatus(tabId)
    const next = terminalStatusFromOutput(lastLine, prev)
    if (next !== prev) statusStore.setStatus(tabId, next)

    if (decayTimerRef.current) window.clearTimeout(decayTimerRef.current)
    decayTimerRef.current = window.setTimeout(() => {
      const current = statusStore.getStatus(tabId)
      if (current === 'working') statusStore.setStatus(tabId, null)
    }, 30_000)
  }, [statusStore, tabId])

  // Release the renderer-side xterm instance while hidden. The PTY keeps
  // running in main and will be reattached from runtime scrollback on show.
  useEffect(() => {
    if (visible) return
    focusClaimRef.current = false
    if (!terminals.has(tabId)) return
    disposeTerminal(tabId, { killRuntime: false, persistScrollback: false })
    initializedRef.current = false
    spawnedRef.current = false
  }, [visible, tabId])

  // Poll SSH status (tracks both connection and disconnection for remote tabs)
  useEffect(() => {
    if (!sshConfig) return
    let cancelled = false
    const check = () => {
      window.api.sshStatus(projectId).then(status => {
        if (!cancelled) setSshReady(status === 'connected')
      })
    }
    check()
    const interval = setInterval(check, 500)
    return () => { cancelled = true; clearInterval(interval) }
  }, [sshConfig, projectId])

  // Respawn PTY after SSH reconnection (detect false→true transition)
  useEffect(() => {
    const wasReady = prevSshReadyRef.current
    prevSshReadyRef.current = sshReady

    if (!sshConfig || !sshReady || !spawnedRef.current) return
    if (wasReady) return // Not a reconnection — was already connected

    // SSH reconnected: save scrollback, kill dead PTY, and reset spawn flag
    const entry = terminals.get(tabId)
    if (entry) {
      try {
        const data = entry.serializeAddon.serialize()
        window.api.scrollbackSaveSync(tabId, data)
      } catch {}
      entry.term.write('\r\n\x1b[33mSSH reconnected — restarting session...\x1b[0m\r\n\r\n')
    }
    window.api.ptyKill(tabId)
    spawnedRef.current = false
    // ResizeObserver effect (also depends on sshReady) will re-run and respawn
  }, [sshReady, tabId, sshConfig])

  useEffect(() => {
    if (!hostRef.current || !config || !visible) return

    const existingEntry = terminals.get(tabId)
    if (existingEntry) {
      const terminalElement = existingEntry.term.element
      if (terminalElement && terminalElement.parentElement !== hostRef.current) {
        hostRef.current.replaceChildren(terminalElement)
        if (visible && document.hasFocus()) {
          existingEntry.fitAddon.fit()
          window.api.ptyResize(tabId, existingEntry.term.cols, existingEntry.term.rows)
        }
      }
      return
    }
    if (initializedRef.current) return
    initializedRef.current = true

    const termTheme = buildXtermTheme(effectiveTerminalTheme, config.terminalColorScheme)

    const term = new Terminal({
      fontFamily: config.fontFamily,
      fontSize: config.fontSize + terminalZoomDelta,
      theme: termTheme,
      allowProposedApi: true,
      cursorBlink: true,
    })

    const fitAddon = new FitAddon()
    const serializeAddon = new SerializeAddon()
    const searchAddon = new SearchAddon()
    const clipboardAddon = new ClipboardAddon()
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      addTab(projectId, taskId, pane, 'browser', { url: normalizeBrowserUrl(uri) })
    }, { urlRegex: WEB_LINK_REGEX })
    const unicode11Addon = new Unicode11Addon()
    const imageAddon = new ImageAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(serializeAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(clipboardAddon)
    term.loadAddon(webLinksAddon)
    term.loadAddon(unicode11Addon)
    term.unicode.activeVersion = '11'
    term.loadAddon(imageAddon)
    term.open(hostRef.current)

    const linkContextMenuBinding = bindTerminalLinkContextMenu(term, setLinkMenu)

    // Defer WebGL to visibility effect — don't eagerly consume a context for hidden tabs
    terminals.set(tabId, {
      term,
      fitAddon,
      serializeAddon,
      searchAddon,
      webglAddon: null,
      scrollbarBinding: null,
      linkContextMenuBinding,
      restoring: false,
      pendingData: [],
      suppressResizeEvents: 0
    })

    term.onData((data) => {
      const currentEntry = terminals.get(tabId)
      if (!currentEntry || currentEntry.restoring) return
      markTaskInteracted(projectId, taskId)
      window.api.ptyWrite(tabId, data)
    })

    term.onResize(({ cols, rows }) => {
      const currentEntry = terminals.get(tabId)
      if (!currentEntry || currentEntry.suppressResizeEvents > 0) return
      window.api.ptyResize(tabId, cols, rows)
    })

    term.element?.addEventListener('focusin', () => {
      focusClaimRef.current = true
      const currentEntry = terminals.get(tabId)
      if (!currentEntry) return
      currentEntry.fitAddon.fit()
      window.api.ptyResize(tabId, currentEntry.term.cols, currentEntry.term.rows)
    })

    term.element?.addEventListener('focusout', () => {
      focusClaimRef.current = false
    })

    if (containerRef.current) {
      const currentEntry = terminals.get(tabId)
      if (currentEntry) {
        currentEntry.scrollbarBinding = bindTransientScrollbar(containerRef.current, term)
      }
    }

    ensurePtyListener()
    ensurePtyExitListener()
    ensurePtySizeListener()
    ensureBeforeUnloadHandler()
  }, [tabId, config, effectiveTerminalTheme, terminalZoomDelta, addTab, pane, projectId, taskId, visible, markTaskInteracted])

  // Manage WebGL addon lifecycle based on visibility
  useEffect(() => {
    const entry = terminals.get(tabId)
    if (!entry) return
    if (visible && ENABLE_XTERM_WEBGL) {
      // Attach WebGL when tab becomes visible (if not already attached)
      if (!entry.webglAddon) {
        entry.webglAddon = attachWebgl(tabId, entry.term)
      }
    } else {
      // Release WebGL context when tab is hidden to stay under the browser limit
      if (entry.webglAddon) {
        try { entry.webglAddon.dispose() } catch { /* already gone */ }
        entry.webglAddon = null
      }
    }
  }, [visible, tabId])

  // Copy on select
  useEffect(() => {
    const entry = terminals.get(tabId)
    if (!entry || !config?.copyOnSelect) return
    const disposable = bindCopyOnSelect(entry.term)
    return () => disposable.dispose()
  }, [tabId, visible, config?.copyOnSelect])

  // Use ResizeObserver to fit terminal when container dimensions change.
  useEffect(() => {
    if (!containerRef.current || !config) return
    const container = containerRef.current
    const ro = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      const entry = terminals.get(tabId)
      if (entry) {
        if (!spawnedRef.current || (visible && document.hasFocus() && focusClaimRef.current)) {
          entry.fitAddon.fit()
        }
        if (!spawnedRef.current && entry.term.cols > 1 && entry.term.rows > 1) {
          if (sshConfig && !sshReady) return // wait for SSH connection
          spawnedRef.current = true
          entry.restoring = true
          entry.pendingData = []

          const attachPromise = shellCommand
            ? window.api.ptySpawn(tabId, '/bin/sh', '/', entry.term.cols, entry.term.rows, ['-c', shellCommand.command])
            : sshConfig
              ? window.api.ptySpawn(tabId, '$SHELL', projectDirRef.current, entry.term.cols, entry.term.rows, ['-l'], undefined, projectId, sshConfig)
              : window.api.ptySpawn(tabId, config.defaultShell || DEFAULT_CONFIG.defaultShell, projectDirRef.current, entry.term.cols, entry.term.rows, ['-l'])

          void attachPromise.then(({ cols, rows, scrollback }) => {
            resizeTerminal(entry, cols, rows)
            const restoredScrollback = sanitizeRestoredScrollback(scrollback)

            const flushPending = () => {
              entry.restoring = false
              if (entry.pendingData.length > 0) {
                entry.term.write(entry.pendingData.join(''))
                entry.pendingData = []
              }
              entry.term.scrollToBottom()
            }

            if (!restoredScrollback) {
              flushPending()
              return
            }

            entry.term.write(restoredScrollback, flushPending)
          }).catch(() => {
            entry.restoring = false
            entry.pendingData = []
            spawnedRef.current = false
          })
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [tabId, config, sshReady, sshConfig, shellCommand, projectId])

  // Focus terminal on visibility change
  useEffect(() => {
    if (visible) {
      const entry = terminals.get(tabId)
      if (entry) {
        if (document.hasFocus()) {
          focusClaimRef.current = true
          entry.fitAddon.fit()
          window.api.ptyResize(tabId, entry.term.cols, entry.term.rows)
        }
        entry.term.focus()
      }
    } else {
      focusClaimRef.current = false
    }
  }, [visible, tabId])

  // Update font when config or zoom changes
  useEffect(() => {
    if (!config) return
    const entry = terminals.get(tabId)
    if (entry) {
      entry.term.options.fontFamily = config.fontFamily
      entry.term.options.fontSize = config.fontSize + terminalZoomDelta
      if (visible && document.hasFocus()) {
        entry.fitAddon.fit()
        window.api.ptyResize(tabId, entry.term.cols, entry.term.rows)
      }
    }
  }, [config?.fontFamily, config?.fontSize, terminalZoomDelta, tabId, visible])

  // Update terminal theme when it changes
  useEffect(() => {
    if (!config) return
    const entry = terminals.get(tabId)
    if (entry) {
      entry.term.options.theme = buildXtermTheme(effectiveTerminalTheme, config.terminalColorScheme)
    }
  }, [effectiveTerminalTheme, config?.terminalColorScheme, tabId, config])

  // Listen for tab removal to dispose
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: removedId } = (e as CustomEvent).detail
      if (removedId === tabId) disposeTerminal(tabId)
    }
    window.addEventListener('tab-removed', handler)
    return () => window.removeEventListener('tab-removed', handler)
  }, [tabId])

  // Cmd+F to open search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!visible) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [visible])

  // Status detection runs independently of the renderer-side terminal entry,
  // so activity keeps updating while the tab is hidden (entry is disposed).
  useEffect(() => {
    statusDetectors.set(tabId, handleOutputForStatus)
    exitListeners.set(tabId, () => statusStore.setStatus(tabId, 'exited'))
    ensurePtyListener()
    ensurePtyExitListener()
    return () => {
      statusDetectors.delete(tabId)
      exitListeners.delete(tabId)
    }
  }, [tabId, handleOutputForStatus, statusStore])

  // Cleanup decay timer on unmount
  useEffect(() => {
    return () => {
      if (decayTimerRef.current) window.clearTimeout(decayTimerRef.current)
    }
  }, [])

  const entry = terminals.get(tabId)

  return (
    <div
      ref={containerRef}
      className="terminal-tab w-full h-full p-1"
      style={{ display: visible ? 'block' : 'none', position: 'relative' }}
    >
      <div ref={hostRef} className="w-full h-full" />
      {entry && (
        <TerminalSearchBar
          searchAddon={entry.searchAddon}
          terminal={entry.term}
          visible={searchOpen}
          onClose={() => setSearchOpen(false)}
        />
      )}
      <LinkContextMenu
        menu={linkMenu}
        onClose={() => setLinkMenu(null)}
        onOpenInApp={(targetUrl) => addTab(projectId, taskId, pane, 'browser', { url: targetUrl })}
      />
    </div>
  )
}

export function disposeTerminal(
  tabId: string,
  { killRuntime = true, persistScrollback = true }: { killRuntime?: boolean; persistScrollback?: boolean } = {}
): void {
  const entry = terminals.get(tabId)
  if (entry) {
    if (persistScrollback) {
      try {
        const data = entry.serializeAddon.serialize()
        window.api.scrollbackSaveSync(tabId, data)
      } catch {
        // Terminal may already be in bad state
      }
    }
    if (entry.webglAddon) {
      try { entry.webglAddon.dispose() } catch { /* already gone */ }
    }
    entry.scrollbarBinding?.dispose()
    entry.linkContextMenuBinding?.dispose()
    disarmXtermDocMouseListeners()
    entry.term.dispose()
    terminals.delete(tabId)
  }
  if (killRuntime) {
    window.api.ptyKill(tabId)
  }
}

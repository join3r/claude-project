import React, { useEffect, useRef, useState } from 'react'
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
import { useApp } from '../context/AppContext'
import { useTabStatusStore } from '../context/TabStatusContext'
import { AI_TAB_META } from '../../shared/types'
import type { AiTabType, SshConfig } from '../../shared/types'
import { buildAiToolArgs, parseExtraArgs } from './aiToolTabUtils'
import '@xterm/xterm/css/xterm.css'
import './AiToolTab.css'

interface Props {
  tabId: string
  toolType: AiTabType
  visible: boolean
  sessionId?: string
  pane: 'left' | 'right'
  projectId: string
  taskId: string
  projectDir: string
  sshConfig?: SshConfig
  extraArgs?: string
}

interface TerminalEntry {
  term: Terminal
  fitAddon: FitAddon
  serializeAddon: SerializeAddon
  searchAddon: SearchAddon
  webglAddon: WebglAddon | null
  restoring: boolean
  pendingData: string[]
  suppressResizeEvents: number
}

const terminals = new Map<string, TerminalEntry>()

let ptyListenerRegistered = false
let exitListenerRegistered = false
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

const activityCallbacks = new Map<string, () => void>()

function ensurePtyListener(): void {
  if (ptyListenerRegistered) return
  ptyListenerRegistered = true
  window.api.onPtyData((id: string, data: string) => {
    const entry = terminals.get(id)
    if (!entry) return
    if (entry.restoring) {
      entry.pendingData.push(data)
      return
    }
    entry.term.write(data)
    activityCallbacks.get(id)?.()
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

const exitCallbacks = new Map<string, (exitCode: number) => void>()

function ensureExitListener(): void {
  if (exitListenerRegistered) return
  exitListenerRegistered = true
  window.api.onPtyExit((id: string, exitCode: number) => {
    exitCallbacks.get(id)?.(exitCode)
  })
}

// Hook listeners (registered once)
let hookListenersRegistered = false
const hookStatusCallbacks = new Map<string, {
  onWorking: () => void
  onStopped: () => void
  onNotification: (body: Record<string, unknown>) => void
  onSessionStart: (body: Record<string, unknown>) => void
}>()

function ensureHookListeners(): void {
  if (hookListenersRegistered) return
  hookListenersRegistered = true

  window.api.onHookWorking((tabId: string) => {
    hookStatusCallbacks.get(tabId)?.onWorking()
  })
  window.api.onHookStopped((tabId: string) => {
    hookStatusCallbacks.get(tabId)?.onStopped()
  })
  window.api.onHookNotification((tabId: string, body: Record<string, unknown>) => {
    hookStatusCallbacks.get(tabId)?.onNotification(body)
  })
  window.api.onHookSessionStart((tabId: string, body: Record<string, unknown>) => {
    hookStatusCallbacks.get(tabId)?.onSessionStart(body)
  })
}

// beforeunload for scrollback (sync save)
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

export default function AiToolTab({ tabId, toolType, visible, sessionId, pane, projectId, taskId, projectDir, sshConfig, extraArgs }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const { config, effectiveTerminalTheme, updateTabSessionId, terminalZoomDelta } = useApp()
  const statusStore = useTabStatusStore()
  const initializedRef = useRef(false)
  const spawnedRef = useRef(false)
  const focusClaimRef = useRef(false)
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressUntilRef = useRef(0)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const [sshReady, setSshReady] = useState(!sshConfig)
  const prevSshReadyRef = useRef(sshReady)
  const [searchOpen, setSearchOpen] = useState(false)
  const isClaudeTab = toolType === 'claude'
  const isCodexTab = toolType === 'codex'
  const codexSpawnTsRef = useRef(0)
  const codexSessionPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const latestSessionIdRef = useRef<string | null>(sessionId ?? null)

  function startCodexSessionPolling(): void {
    if (codexSessionPollRef.current) return
    codexSessionPollRef.current = setInterval(refreshCodexSessionId, 2000)
  }

  function stopCodexSessionPolling(): void {
    if (codexSessionPollRef.current) {
      clearInterval(codexSessionPollRef.current)
      codexSessionPollRef.current = null
    }
  }

  async function refreshCodexSessionId(): Promise<void> {
    if (!isCodexTab) return

    // Resume case: stop polling after 30 seconds if no new session found
    if (latestSessionIdRef.current && Date.now() / 1000 > codexSpawnTsRef.current + 30) {
      stopCodexSessionPolling()
      return
    }

    try {
      const cwd = sshConfig ? sshConfig.remoteDir : projectDir
      const { sessionId: latestSessionId } = await window.api.codexReadSession(
        cwd,
        codexSpawnTsRef.current,
        sshConfig ? projectId : undefined,
        sshConfig
      )

      if (!latestSessionId || latestSessionId === latestSessionIdRef.current) return

      latestSessionIdRef.current = latestSessionId
      updateTabSessionId(projectId, taskId, pane, tabId, latestSessionId)
      stopCodexSessionPolling()
    } catch {
      // sqlite3 not available or remote host reconnecting — skip this cycle.
    }
  }

  // Poll SSH status (tracks both connection and disconnection for remote tabs)
  useEffect(() => {
    if (!sshConfig) return
    let cancelled = false
    const check = () => {
      window.api.sshStatus(projectId).then(status => {
        if (cancelled) return
        setSshReady(status === 'connected')
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
    statusStore.setStatus(tabId, null) // Clear exited status
    spawnedRef.current = false
    if (isCodexTab) {
      stopCodexSessionPolling()
    }
    // ResizeObserver effect (also depends on sshReady) will re-run and respawn
  }, [sshReady, tabId, sshConfig])

  useEffect(() => {
    if (!hostRef.current || !config) return

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

    const termTheme = effectiveTerminalTheme === 'light'
      ? { background: '#ffffff', foreground: '#333333', cursor: '#000000', selectionBackground: 'rgba(0, 120, 215, 0.3)', selectionInactiveBackground: 'rgba(0, 120, 215, 0.15)', scrollbarSliderBackground: 'rgba(0, 0, 0, 0.2)', scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.3)', scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.4)' }
      : { background: '#1e1e1e', foreground: '#cccccc', cursor: '#ffffff', selectionBackground: 'rgba(255, 255, 255, 0.3)', selectionInactiveBackground: 'rgba(255, 255, 255, 0.15)', scrollbarSliderBackground: 'rgba(255, 255, 255, 0.15)', scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.25)', scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.35)' }

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
    const webLinksAddon = new WebLinksAddon()
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

    // Defer WebGL to visibility effect — don't eagerly consume a context for hidden tabs
    terminals.set(tabId, {
      term,
      fitAddon,
      serializeAddon,
      searchAddon,
      webglAddon: null,
      restoring: false,
      pendingData: [],
      suppressResizeEvents: 0
    })

    term.onData((data) => {
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

    // Show scrollbar only while scrolling
    let scrollTimer: ReturnType<typeof setTimeout> | null = null
    term.onScroll(() => {
      containerRef.current?.classList.add('is-scrolling')
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => containerRef.current?.classList.remove('is-scrolling'), 800)
    })

    if (isClaudeTab) {
      // Hook-based status tracking for Claude Code
      // Uses stable projectId/taskId props, not global selection state
      hookStatusCallbacks.set(tabId, {
        onWorking: () => {
          const current = statusStore.getStatus(tabId)
          if (current !== 'exited') {
            statusStore.setStatus(tabId, 'working')
          }
        },
        onStopped: () => {
          const current = statusStore.getStatus(tabId)
          if (current === 'working') {
            statusStore.setStatus(tabId, null)
          }
        },
        onNotification: () => {
          const current = statusStore.getStatus(tabId)
          if (current !== 'exited') {
            statusStore.setStatus(tabId, 'attention')
          }
        },
        onSessionStart: (body: Record<string, unknown>) => {
          const newSessionId = body.session_id as string | undefined
          if (newSessionId) {
            updateTabSessionId(projectId, taskId, pane, tabId, newSessionId)
          }
        }
      })

      ensureHookListeners()
    } else {
      // Non-Claude AI tabs: keep PTY output heuristic
      activityCallbacks.set(tabId, () => {
        if (Date.now() < suppressUntilRef.current) return
        const current = statusStore.getStatus(tabId)
        if (current === 'exited') return
        if (current !== 'attention') {
          statusStore.setStatus(tabId, 'working')
        }
        if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
        activityTimerRef.current = setTimeout(() => {
          const latest = statusStore.getStatus(tabId)
          if (latest === 'working') {
            statusStore.setStatus(tabId, visibleRef.current ? null : 'attention')
          }
        }, 3000)
      })

      term.onBell(() => {
        statusStore.setStatus(tabId, 'attention')
      })
    }

    // Exit callback (both Claude and non-Claude)
    exitCallbacks.set(tabId, () => {
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
      statusStore.setStatus(tabId, 'exited')
    })

    ensurePtyListener()
    ensurePtySizeListener()
    ensureExitListener()
    ensureBeforeUnloadHandler()
  }, [tabId, toolType, config])

  // Manage WebGL addon lifecycle based on visibility
  useEffect(() => {
    const entry = terminals.get(tabId)
    if (!entry) return
    if (visible) {
      // Attach WebGL when tab becomes visible (if not already attached)
      if (!entry.webglAddon) {
        try {
          const addon = new WebglAddon()
          addon.onContextLoss(() => {
            try { addon.dispose() } catch { /* already gone */ }
            const e = terminals.get(tabId)
            if (e) e.webglAddon = null
          })
          entry.term.loadAddon(addon)
          entry.webglAddon = addon
        } catch {
          // WebGL not available — canvas renderer is fine
        }
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
    const disposable = entry.term.onSelectionChange(() => {
      const selection = entry.term.getSelection()
      if (selection) navigator.clipboard.writeText(selection)
    })
    return () => disposable.dispose()
  }, [tabId, config?.copyOnSelect])

  // ResizeObserver for fitting + spawning
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

          const startSession = async (): Promise<void> => {
            let resumeSessionId = sessionId

            const command = AI_TAB_META[toolType].command
            const parsedExtra = parseExtraArgs(extraArgs)
            const args = buildAiToolArgs(toolType, parsedExtra, resumeSessionId)

            let extraEnv: Record<string, string> | undefined
            if (isClaudeTab) {
              extraEnv = { DEVTOOL_TAB_ID: tabId }
            }

            // Record spawn timestamp for Codex session polling
            if (isCodexTab) {
              codexSpawnTsRef.current = Math.floor(Date.now() / 1000)
            }

            entry.restoring = true
            entry.pendingData = []

            const attachResult = sshConfig
              ? await window.api.ptySpawn(tabId, command, '', entry.term.cols, entry.term.rows, args, extraEnv, projectId, sshConfig)
              : await window.api.ptySpawn(tabId, command, projectDir, entry.term.cols, entry.term.rows, args, extraEnv)

            resizeTerminal(entry, attachResult.cols, attachResult.rows)

            const flushPending = () => {
              entry.restoring = false
              if (entry.pendingData.length > 0) {
                entry.term.write(entry.pendingData.join(''))
                entry.pendingData = []
              }
              entry.term.scrollToBottom()
            }

            if (attachResult.scrollback) {
              await new Promise<void>(resolve => {
                entry.term.write(attachResult.scrollback, () => {
                  flushPending()
                  resolve()
                })
              })
            } else {
              flushPending()
            }

            if (attachResult.exitCode !== null) {
              exitCallbacks.get(tabId)?.(attachResult.exitCode)
            }

            if (isCodexTab) {
              startCodexSessionPolling()
            }
          }
          void startSession().catch(() => {
            entry.restoring = false
            entry.pendingData = []
            spawnedRef.current = false
          })
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [tabId, toolType, config, sessionId, projectDir, sshReady])

  // Focus + re-fit on visibility change, clear attention
  useEffect(() => {
    if (visible) {
      if (!isClaudeTab) {
        suppressUntilRef.current = Date.now() + 500
      }
      const entry = terminals.get(tabId)
      if (entry) {
        if (document.hasFocus()) {
          entry.fitAddon.fit()
          focusClaimRef.current = true
          window.api.ptyResize(tabId, entry.term.cols, entry.term.rows)
        }
        entry.term.focus()
        const current = statusStore.getStatus(tabId)
        if (current === 'attention') {
          statusStore.setStatus(tabId, null)
        }
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

  // Update terminal theme
  useEffect(() => {
    const entry = terminals.get(tabId)
    if (entry) {
      entry.term.options.theme = effectiveTerminalTheme === 'light'
        ? { background: '#ffffff', foreground: '#333333', cursor: '#000000', selectionBackground: 'rgba(0, 120, 215, 0.3)', selectionInactiveBackground: 'rgba(0, 120, 215, 0.15)', scrollbarSliderBackground: 'rgba(0, 0, 0, 0.2)', scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.3)', scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.4)' }
        : { background: '#1e1e1e', foreground: '#cccccc', cursor: '#ffffff', selectionBackground: 'rgba(255, 255, 255, 0.3)', selectionInactiveBackground: 'rgba(255, 255, 255, 0.15)', scrollbarSliderBackground: 'rgba(255, 255, 255, 0.15)', scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.25)', scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.35)' }
    }
  }, [effectiveTerminalTheme, tabId])

  // Cleanup on tab removal
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: removedId } = (e as CustomEvent).detail
      if (removedId === tabId) {
        const entry = terminals.get(tabId)
        if (entry) {
          // Save scrollback before disposing (sync for reliability)
          try {
            const data = entry.serializeAddon.serialize()
            window.api.scrollbackSaveSync(tabId, data)
          } catch {
            // Terminal may already be in bad state
          }
          entry.term.dispose()
          terminals.delete(tabId)
          window.api.ptyKill(tabId)
        }
        exitCallbacks.delete(tabId)
        activityCallbacks.delete(tabId)
        hookStatusCallbacks.delete(tabId)
        statusStore.removeTab(tabId)

        // Cleanup hooks when Claude tab is removed (ref-counted)
        if (isClaudeTab) {
          if (sshConfig) {
            window.api.hooksCleanupRemote(projectId, sshConfig)
          } else {
            window.api.hooksCleanup(projectDir)
          }
        }
      }
    }
    window.addEventListener('tab-removed', handler)
    return () => window.removeEventListener('tab-removed', handler)
  }, [tabId, isClaudeTab, projectDir])

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

  const entry = terminals.get(tabId)

  return (
    <div
      ref={containerRef}
      className="ai-tool-tab"
      style={{ display: visible ? 'block' : 'none', position: 'relative' }}
    >
      <div ref={hostRef} className="ai-tool-tab-host" />
      {entry && (
        <TerminalSearchBar
          searchAddon={entry.searchAddon}
          terminal={entry.term}
          visible={searchOpen}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  )
}

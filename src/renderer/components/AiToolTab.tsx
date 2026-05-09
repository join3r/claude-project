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
import { bindCopyOnSelect } from './copyOnSelect'
import { bindTransientScrollbar } from './transientScrollbar'
import { useApp } from '../context/AppContext'
import { useTabStatusStore } from '../context/TabStatusContext'
import { AI_TAB_META } from '../../shared/types'
import type { AiTabType, SshConfig } from '../../shared/types'
import { buildAiToolArgs, parseExtraArgs } from './aiToolTabUtils'
import { normalizeBrowserUrl } from '../browserUrl'
import { sanitizeRestoredScrollback } from './scrollbackReplay'
import '@xterm/xterm/css/xterm.css'
import { buildXtermTheme } from './terminalThemes'

const ENABLE_XTERM_WEBGL = false

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
  scrollbarBinding: { dispose(): void } | null
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
    if (!entry) {
      activityCallbacks.get(id)?.()
      return
    }
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
  const { addTab, config, effectiveTerminalTheme, updateTabSessionId, terminalZoomDelta, markTaskInteracted } = useApp()
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
  // Lazy loading: Claude tabs with prior activity (sessionId or saved scrollback)
  // require explicit user activation before spawning, so resuming doesn't burn
  // tokens on app startup. Brand-new Claude tabs (no prior activity) auto-spawn.
  // null = still checking disk, true/false = decided.
  const lazyLoadEnabled = config?.lazyLoadClaude ?? true
  const [hadPriorActivity, setHadPriorActivity] = useState<boolean | null>(
    isClaudeTab ? (sessionId ? true : null) : false
  )
  const requiresActivation = isClaudeTab && lazyLoadEnabled && hadPriorActivity === true
  const activationDecisionPending = isClaudeTab && lazyLoadEnabled && hadPriorActivity === null
  const [userActivated, setUserActivated] = useState(false)
  const userActivatedRef = useRef(false)
  userActivatedRef.current = userActivated
  const scrollbackPreloadedRef = useRef(false)

  // Probe disk for existing scrollback to decide if this Claude tab counts as
  // having prior activity (and therefore needs lazy activation).
  useEffect(() => {
    if (!isClaudeTab || sessionId) return
    let cancelled = false
    window.api.scrollbackLoad(tabId).then(data => {
      if (cancelled) return
      setHadPriorActivity(!!data && data.length > 0)
    }).catch(() => {
      if (cancelled) return
      setHadPriorActivity(false)
    })
    return () => { cancelled = true }
  }, [tabId, isClaudeTab, sessionId])

  // Release the renderer-side xterm instance while hidden. The PTY keeps
  // running in main and will be reattached from runtime scrollback on show.
  useEffect(() => {
    if (visible) return
    focusClaimRef.current = false
    if (!terminals.has(tabId)) return
    disposeAiToolTerminal(tabId, { killRuntime: false, persistScrollback: false })
    initializedRef.current = false
    spawnedRef.current = false
    scrollbackPreloadedRef.current = false
  }, [visible, tabId])

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
      const cwd = projectDir
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
      event.preventDefault()
      event.stopPropagation()
      addTab(projectId, taskId, pane, 'browser', { url: normalizeBrowserUrl(uri) })
    })
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
      scrollbarBinding: null,
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
    }

    // PTY-based activity heuristic for all AI tabs. For Claude this is a fallback
    // signal so the watch strip / sidebar still reflect activity when hooks
    // haven't been configured or before they fire. For non-Claude tabs it's the
    // primary signal. Hook-driven 'attention' is preserved (not overwritten).
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

    if (!isClaudeTab) {
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
  }, [tabId, toolType, config, addTab, pane, projectId, taskId, visible, markTaskInteracted])

  // Show stored scrollback in the xterm before the user clicks Resume so they
  // can see what the session was about. Skipped if the tab will auto-spawn
  // anyway — that path writes scrollback itself after PTY attach.
  useEffect(() => {
    if (!visible || !requiresActivation || userActivated || scrollbackPreloadedRef.current) return
    const entry = terminals.get(tabId)
    if (!entry) return
    let cancelled = false
    window.api.scrollbackLoad(tabId).then(data => {
      if (cancelled) return
      const sanitized = sanitizeRestoredScrollback(data ?? '')
      if (sanitized) {
        entry.term.write(sanitized, () => {
          entry.term.scrollToBottom()
        })
      }
      scrollbackPreloadedRef.current = true
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [visible, requiresActivation, userActivated, tabId])

  // Manage WebGL addon lifecycle based on visibility
  useEffect(() => {
    const entry = terminals.get(tabId)
    if (!entry) return
    if (visible && ENABLE_XTERM_WEBGL) {
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
    const disposable = bindCopyOnSelect(entry.term)
    return () => disposable.dispose()
  }, [tabId, visible, config?.copyOnSelect])

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
          if (activationDecisionPending) return // wait until we've checked disk for prior scrollback
          if (requiresActivation && !userActivatedRef.current) return // wait for explicit user activation
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
              ? await window.api.ptySpawn(tabId, command, projectDir, entry.term.cols, entry.term.rows, args, extraEnv, projectId, sshConfig)
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

            const restoredScrollback = sanitizeRestoredScrollback(attachResult.scrollback)

            // Skip the rewrite if we already pre-loaded scrollback for the
            // unloaded-state preview — same disk file, no need to duplicate.
            if (restoredScrollback && !scrollbackPreloadedRef.current) {
              await new Promise<void>(resolve => {
                entry.term.write(restoredScrollback, () => {
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
  }, [tabId, toolType, config, sessionId, projectDir, sshReady, userActivated, activationDecisionPending])

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
    if (!config) return
    const entry = terminals.get(tabId)
    if (entry) {
      entry.term.options.theme = buildXtermTheme(effectiveTerminalTheme, config.terminalColorScheme)
    }
  }, [effectiveTerminalTheme, config?.terminalColorScheme, tabId, config])

  // Cleanup on tab removal
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: removedId } = (e as CustomEvent).detail
      if (removedId === tabId) {
        disposeAiToolTerminal(tabId)
        exitCallbacks.delete(tabId)
        activityCallbacks.delete(tabId)
        hookStatusCallbacks.delete(tabId)
        statusStore.removeTab(tabId)

        // Cleanup hooks when Claude tab is removed (ref-counted)
        if (isClaudeTab) {
          if (sshConfig) {
            window.api.hooksCleanupRemote(projectId, sshConfig, projectDir)
          } else {
            window.api.hooksCleanup(projectDir)
          }
        }
      }
    }
    window.addEventListener('tab-removed', handler)
    return () => window.removeEventListener('tab-removed', handler)
  }, [tabId, isClaudeTab, projectDir, projectId, sshConfig])

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
      className="ai-tool-tab w-full h-full p-1"
      style={{ display: visible ? 'block' : 'none', position: 'relative' }}
    >
      <div ref={hostRef} className="w-full h-full" />
      {requiresActivation && !userActivated && visible && (
        <div
          className="absolute inset-x-0 bottom-0 flex items-center justify-center cursor-pointer z-10 py-3 bg-gradient-to-t from-bg-base/95 via-bg-base/70 to-transparent"
          onMouseDown={() => setUserActivated(true)}
        >
          <div className="text-text text-[13px] px-4 py-2 rounded border border-border-default bg-bg-elevated shadow-lg hover:border-accent-400">
            Click to resume Claude session
          </div>
        </div>
      )}
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

function disposeAiToolTerminal(
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
    entry.term.dispose()
    terminals.delete(tabId)
  }
  if (killRuntime) {
    window.api.ptyKill(tabId)
  }
}

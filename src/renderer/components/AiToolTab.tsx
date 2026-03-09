import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import { useApp } from '../context/AppContext'
import { useTabStatusStore } from '../context/TabStatusContext'
import { AI_TAB_META } from '../../shared/types'
import type { AiTabType, SshConfig } from '../../shared/types'
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
}

const terminals = new Map<string, { term: Terminal; fitAddon: FitAddon; serializeAddon: SerializeAddon }>()

let ptyListenerRegistered = false
let exitListenerRegistered = false

const activityCallbacks = new Map<string, () => void>()

function ensurePtyListener(): void {
  if (ptyListenerRegistered) return
  ptyListenerRegistered = true
  window.api.onPtyData((id: string, data: string) => {
    terminals.get(id)?.term.write(data)
    activityCallbacks.get(id)?.()
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

export default function AiToolTab({ tabId, toolType, visible, sessionId, pane, projectId, taskId, projectDir, sshConfig }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const { config, effectiveTerminalTheme, updateTabSessionId } = useApp()
  const statusStore = useTabStatusStore()
  const initializedRef = useRef(false)
  const spawnedRef = useRef(false)
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressUntilRef = useRef(0)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const [sshReady, setSshReady] = useState(!sshConfig)

  // Poll SSH status until connected (for remote tabs)
  useEffect(() => {
    if (!sshConfig) return
    let cancelled = false
    const check = () => {
      window.api.sshStatus(projectId).then(status => {
        if (!cancelled && status === 'connected') setSshReady(true)
      })
    }
    check()
    const interval = setInterval(check, 500)
    return () => { cancelled = true; clearInterval(interval) }
  }, [sshConfig, projectId])

  const isClaudeTab = toolType === 'claude'

  useEffect(() => {
    if (!containerRef.current || !config) return
    if (initializedRef.current) return
    initializedRef.current = true

    const termTheme = effectiveTerminalTheme === 'light'
      ? { background: '#ffffff', foreground: '#333333', cursor: '#000000', selectionBackground: 'rgba(0, 120, 215, 0.3)', selectionInactiveBackground: 'rgba(0, 120, 215, 0.15)', scrollbarSliderBackground: 'rgba(0, 0, 0, 0.2)', scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.3)', scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.4)' }
      : { background: '#1e1e1e', foreground: '#cccccc', cursor: '#ffffff', selectionBackground: 'rgba(255, 255, 255, 0.3)', selectionInactiveBackground: 'rgba(255, 255, 255, 0.15)', scrollbarSliderBackground: 'rgba(255, 255, 255, 0.15)', scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.25)', scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.35)' }

    const term = new Terminal({
      fontFamily: config.fontFamily,
      fontSize: config.fontSize,
      theme: termTheme,
      allowProposedApi: true,
      cursorBlink: true,
    })

    const fitAddon = new FitAddon()
    const serializeAddon = new SerializeAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(serializeAddon)
    term.open(containerRef.current)

    try {
      const webglAddon = new WebglAddon()
      term.loadAddon(webglAddon)
    } catch {
      // WebGL not available
    }

    terminals.set(tabId, { term, fitAddon, serializeAddon })

    term.onData((data) => {
      window.api.ptyWrite(tabId, data)
    })

    term.onResize(({ cols, rows }) => {
      window.api.ptyResize(tabId, cols, rows)
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
    ensureExitListener()
    ensureBeforeUnloadHandler()
  }, [tabId, toolType, config])

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
        entry.fitAddon.fit()
        if (!spawnedRef.current && entry.term.cols > 1 && entry.term.rows > 1) {
          if (sshConfig && !sshReady) return // wait for SSH connection
          spawnedRef.current = true

          const startSession = async (): Promise<void> => {
            // Restore scrollback only for non-resume tabs (resume re-outputs content)
            if (!sessionId) {
              const data = await window.api.scrollbackLoad(tabId)
              if (data) {
                await new Promise<void>(resolve => {
                  entry.term.write(data, () => {
                    // After xterm processes scrollback, re-sync viewport dimensions
                    entry.fitAddon.fit()
                    entry.term.scrollToBottom()
                    resolve()
                  })
                })
              }
            }

            // Ensure hooks are injected before spawning Claude
            if (isClaudeTab) {
              if (sshConfig) {
                // Remote hooks injected inline via SSH spawn args — skip local injection
              } else {
                await window.api.hooksInject(projectDir)
              }
            }

            const command = AI_TAB_META[toolType].command
            const args = sessionId ? ['--resume', sessionId] : []
            const extraEnv = isClaudeTab ? { DEVTOOL_TAB_ID: tabId } : undefined
            if (sshConfig) {
              window.api.ptySpawn(tabId, command, '', entry.term.cols, entry.term.rows, args, extraEnv, projectId, sshConfig)
            } else {
              window.api.ptySpawn(tabId, command, projectDir, entry.term.cols, entry.term.rows, args, extraEnv)
            }
          }
          startSession()
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
        entry.fitAddon.fit()
        entry.term.focus()
        const current = statusStore.getStatus(tabId)
        if (current === 'attention') {
          statusStore.setStatus(tabId, null)
        }
      }
    }
  }, [visible, tabId])

  // Update font when config changes
  useEffect(() => {
    if (!config) return
    const entry = terminals.get(tabId)
    if (entry) {
      entry.term.options.fontFamily = config.fontFamily
      entry.term.options.fontSize = config.fontSize
      entry.fitAddon.fit()
    }
  }, [config?.fontFamily, config?.fontSize, tabId])

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

  return (
    <div
      ref={containerRef}
      className="ai-tool-tab"
      style={{ display: visible ? 'block' : 'none' }}
    />
  )
}

import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { useApp } from '../context/AppContext'
import { useTabStatusStore } from '../context/TabStatusContext'
import { AI_TAB_META } from '../../shared/types'
import type { AiTabType } from '../../shared/types'
import '@xterm/xterm/css/xterm.css'
import './AiToolTab.css'

interface Props {
  tabId: string
  toolType: AiTabType
  visible: boolean
}

const terminals = new Map<string, { term: Terminal; fitAddon: FitAddon }>()

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

export default function AiToolTab({ tabId, toolType, visible }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const { selectedProject, config, effectiveTerminalTheme } = useApp()
  const statusStore = useTabStatusStore()
  const initializedRef = useRef(false)
  const spawnedRef = useRef(false)
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressUntilRef = useRef(0)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  useEffect(() => {
    if (!containerRef.current || !selectedProject || !config) return
    if (initializedRef.current) return
    initializedRef.current = true

    const termTheme = effectiveTerminalTheme === 'light'
      ? { background: '#ffffff', foreground: '#333333', cursor: '#000000' }
      : { background: '#1e1e1e', foreground: '#cccccc', cursor: '#ffffff' }

    const term = new Terminal({
      fontFamily: config.fontFamily,
      fontSize: config.fontSize,
      theme: termTheme,
      allowProposedApi: true,
      cursorBlink: true
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    try {
      const webglAddon = new WebglAddon()
      term.loadAddon(webglAddon)
    } catch {
      // WebGL not available
    }

    terminals.set(tabId, { term, fitAddon })

    term.onData((data) => {
      window.api.ptyWrite(tabId, data)
    })

    term.onResize(({ cols, rows }) => {
      window.api.ptyResize(tabId, cols, rows)
    })

    // Track pty output activity (not input echo) via activityCallbacks
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
          // If tab not visible, tool probably needs attention (finished work)
          // If tab visible, user can see it — just clear to idle
          statusStore.setStatus(tabId, visibleRef.current ? null : 'attention')
        }
      }, 3000)
    })

    // Bell = needs attention
    term.onBell(() => {
      statusStore.setStatus(tabId, 'attention')
    })

    // Exit callback
    exitCallbacks.set(tabId, () => {
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
      statusStore.setStatus(tabId, 'exited')
    })

    ensurePtyListener()
    ensureExitListener()
  }, [tabId, toolType, selectedProject, config])

  // ResizeObserver for fitting + spawning
  useEffect(() => {
    if (!containerRef.current || !selectedProject || !config) return
    const container = containerRef.current
    const ro = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      const entry = terminals.get(tabId)
      if (entry) {
        entry.fitAddon.fit()
        if (!spawnedRef.current && entry.term.cols > 1 && entry.term.rows > 1) {
          spawnedRef.current = true
          const command = AI_TAB_META[toolType].command
          window.api.ptySpawn(tabId, command, selectedProject.directory, entry.term.cols, entry.term.rows)
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [tabId, toolType, selectedProject, config])

  // Focus + re-fit on visibility change, clear attention
  useEffect(() => {
    if (visible) {
      // Suppress activity tracking briefly to ignore resize-triggered output
      suppressUntilRef.current = Date.now() + 500
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
        ? { background: '#ffffff', foreground: '#333333', cursor: '#000000' }
        : { background: '#1e1e1e', foreground: '#cccccc', cursor: '#ffffff' }
    }
  }, [effectiveTerminalTheme, tabId])

  // Cleanup on tab removal
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: removedId } = (e as CustomEvent).detail
      if (removedId === tabId) {
        const entry = terminals.get(tabId)
        if (entry) {
          entry.term.dispose()
          terminals.delete(tabId)
          window.api.ptyKill(tabId)
        }
        exitCallbacks.delete(tabId)
        activityCallbacks.delete(tabId)
        statusStore.removeTab(tabId)
      }
    }
    window.addEventListener('tab-removed', handler)
    return () => window.removeEventListener('tab-removed', handler)
  }, [tabId])

  return (
    <div
      ref={containerRef}
      className="ai-tool-tab"
      style={{ display: visible ? 'block' : 'none' }}
    />
  )
}

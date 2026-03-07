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

function ensurePtyListener(): void {
  if (ptyListenerRegistered) return
  ptyListenerRegistered = true
  window.api.onPtyData((id: string, data: string) => {
    terminals.get(id)?.term.write(data)
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

    // Bell = needs attention
    term.onBell(() => {
      statusStore.setStatus(tabId, 'attention')
    })

    // Exit callback
    exitCallbacks.set(tabId, () => {
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
      const entry = terminals.get(tabId)
      if (entry) {
        entry.fitAddon.fit()
        if (!spawnedRef.current && entry.term.cols > 1 && entry.term.rows > 1) {
          spawnedRef.current = true
          const command = AI_TAB_META[toolType].command
          window.api.ptySpawn(tabId, command, selectedProject.directory, entry.term.cols, entry.term.rows)
          statusStore.setStatus(tabId, 'working')
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [tabId, toolType, selectedProject, config])

  // Focus on visibility change + clear attention
  useEffect(() => {
    if (visible) {
      const entry = terminals.get(tabId)
      if (entry) {
        entry.term.focus()
        const current = statusStore.getStatus(tabId)
        if (current === 'attention') {
          statusStore.setStatus(tabId, 'working')
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

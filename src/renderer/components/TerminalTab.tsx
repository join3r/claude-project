import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { useApp } from '../context/AppContext'
import '@xterm/xterm/css/xterm.css'
import './TerminalTab.css'

interface Props {
  tabId: string
  visible: boolean
}

const terminals = new Map<string, { term: Terminal; fitAddon: FitAddon }>()

let ptyListenerRegistered = false
function ensurePtyListener(): void {
  if (ptyListenerRegistered) return
  ptyListenerRegistered = true
  window.api.onPtyData((id: string, data: string) => {
    terminals.get(id)?.term.write(data)
  })
}

export default function TerminalTab({ tabId, visible }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const { selectedProject, config } = useApp()
  const initializedRef = useRef(false)

  useEffect(() => {
    if (!containerRef.current || !selectedProject || !config) return
    if (initializedRef.current) return
    initializedRef.current = true

    const term = new Terminal({
      fontFamily: config.fontFamily,
      fontSize: config.fontSize,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#ffffff'
      },
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
      // WebGL not available, fallback to canvas
    }

    fitAddon.fit()
    terminals.set(tabId, { term, fitAddon })

    const shell = config.defaultShell
    const cols = term.cols
    const rows = term.rows

    window.api.ptySpawn(tabId, shell, selectedProject.directory, cols, rows)

    term.onData((data) => {
      window.api.ptyWrite(tabId, data)
    })

    term.onResize(({ cols, rows }) => {
      window.api.ptyResize(tabId, cols, rows)
    })

    ensurePtyListener()
  }, [tabId, selectedProject, config])

  // Fit on visibility change
  useEffect(() => {
    if (visible) {
      const entry = terminals.get(tabId)
      if (entry) {
        setTimeout(() => entry.fitAddon.fit(), 50)
        entry.term.focus()
      }
    }
  }, [visible, tabId])

  // Fit on window resize
  useEffect(() => {
    const onResize = () => {
      if (visible) terminals.get(tabId)?.fitAddon.fit()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
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

  // Listen for tab removal to dispose
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: removedId } = (e as CustomEvent).detail
      if (removedId === tabId) disposeTerminal(tabId)
    }
    window.addEventListener('tab-removed', handler)
    return () => window.removeEventListener('tab-removed', handler)
  }, [tabId])

  return (
    <div
      ref={containerRef}
      className="terminal-tab"
      style={{ display: visible ? 'block' : 'none' }}
    />
  )
}

export function disposeTerminal(tabId: string): void {
  const entry = terminals.get(tabId)
  if (entry) {
    entry.term.dispose()
    terminals.delete(tabId)
    window.api.ptyKill(tabId)
  }
}

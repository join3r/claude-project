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
  const { selectedProject, config, effectiveTerminalTheme } = useApp()
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
      // WebGL not available, fallback to canvas
    }

    terminals.set(tabId, { term, fitAddon })

    term.onData((data) => {
      window.api.ptyWrite(tabId, data)
    })

    term.onResize(({ cols, rows }) => {
      window.api.ptyResize(tabId, cols, rows)
    })

    ensurePtyListener()
  }, [tabId, selectedProject, config])

  // Use ResizeObserver to fit terminal when container dimensions change.
  // This handles initial layout, window resize, visibility changes, and
  // sidebar toggles — all cases where the container size may change.
  useEffect(() => {
    if (!containerRef.current || !selectedProject || !config) return
    const container = containerRef.current
    const ro = new ResizeObserver(() => {
      const entry = terminals.get(tabId)
      if (entry) {
        entry.fitAddon.fit()
        // Spawn PTY on first real fit (container has non-zero size)
        if (!spawnedRef.current && entry.term.cols > 1 && entry.term.rows > 1) {
          spawnedRef.current = true
          window.api.ptySpawn(tabId, config.defaultShell, selectedProject.directory, entry.term.cols, entry.term.rows)
        }
      }
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [tabId, selectedProject, config])

  // Focus terminal on visibility change
  useEffect(() => {
    if (visible) {
      const entry = terminals.get(tabId)
      if (entry) {
        entry.term.focus()
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

  // Update terminal theme when it changes
  useEffect(() => {
    const entry = terminals.get(tabId)
    if (entry) {
      entry.term.options.theme = effectiveTerminalTheme === 'light'
        ? { background: '#ffffff', foreground: '#333333', cursor: '#000000' }
        : { background: '#1e1e1e', foreground: '#cccccc', cursor: '#ffffff' }
    }
  }, [effectiveTerminalTheme, tabId])

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

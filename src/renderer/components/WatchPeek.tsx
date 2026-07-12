// src/renderer/components/WatchPeek.tsx
import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../context/AppContext'

interface Props {
  projectId: string
  taskId: string
  pane: 'left' | 'right'
  tabId: string
  anchorRect: DOMRect
  onEnter: () => void
  onLeave: () => void
}

const PEEK_LINES = 10

export function WatchPeek({ projectId, taskId, pane, tabId, anchorRect, onEnter, onLeave }: Props): React.ReactElement {
  const actions = useApp()
  const [lines, setLines] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const api = (window as any).api
      if (!api?.scrollbackLoad) return
      try {
        const raw: string = (await api.scrollbackLoad(tabId)) ?? ''
        if (cancelled) return
        // Strip ANSI escapes for a readable peek.
        const stripped = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        const all = stripped.split(/\r?\n/).filter(Boolean)
        setLines(all.slice(-PEEK_LINES))
      } catch { /* ignore */ }
    }
    void tick()
    const t = window.setInterval(tick, 1000)
    return () => { cancelled = true; window.clearInterval(t) }
  }, [tabId])

  const onOpen = () => {
    actions.switchToTask(projectId, taskId)
    actions.setActiveTab(projectId, taskId, pane, tabId)
  }
  const onUnpin = () => actions.setTabPinned(projectId, taskId, pane, tabId, false)

  const gap = 8
  const left = Math.max(gap, Math.min(window.innerWidth - 360 - gap, anchorRect.left))
  const bottom = Math.max(gap, window.innerHeight - anchorRect.top + gap)
  const maxHeight = Math.max(80, anchorRect.top - gap * 2)

  return createPortal(
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: 'fixed', left, bottom, width: 360, maxHeight }}
      className="bg-surface border-[0.5px] border-border rounded-lg shadow-pop text-text z-(--z-popover) flex flex-col"
    >
      <div className="px-3 py-2 border-b border-hair text-xs text-text-subtle font-mono shrink-0">last {PEEK_LINES} lines</div>
      <div className="px-3 py-2 max-h-[180px] min-h-0 overflow-y-auto font-mono text-xs whitespace-pre-wrap">
        {lines.length === 0 ? <em className="text-text-subtle">no output yet</em> : lines.join('\n')}
      </div>
      <div className="px-3 py-2 flex justify-between border-t border-hair shrink-0">
        <button type="button" onClick={onOpen} className="text-sm text-accent hover:underline bg-transparent border-0 p-0 cursor-pointer">Open</button>
        <button type="button" onClick={onUnpin} className="text-sm text-accent hover:underline bg-transparent border-0 p-0 cursor-pointer">Unpin</button>
      </div>
    </div>,
    document.body
  )
}

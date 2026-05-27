// src/renderer/components/WatchStrip.tsx
import React, { useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import { WatchTile } from './WatchTile'
import { paletteEvents } from '../palette/paletteEvents'
import { pinKey } from '../../shared/types'

interface PinnedRef {
  projectId: string
  taskId: string
  pane: 'left' | 'right'
  tabId: string
  key: string
}

const DRAG_THRESHOLD = 4

export function WatchStrip(): React.ReactElement | null {
  const actions = useApp()
  const listRef = useRef<HTMLDivElement>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  if (actions.watchStripHidden) return null

  const naturalPins: PinnedRef[] = []
  for (const project of actions.projects) {
    for (const task of project.tasks) {
      for (const pane of ['left', 'right'] as const) {
        for (const tab of task.tabs[pane]) {
          if (tab.pinned) {
            naturalPins.push({
              projectId: project.id,
              taskId: task.id,
              pane,
              tabId: tab.id,
              key: pinKey(project.id, task.id, pane, tab.id)
            })
          }
        }
      }
    }
  }
  if (naturalPins.length === 0) return null

  const byKey = new Map(naturalPins.map(p => [p.key, p]))
  const ordered: PinnedRef[] = []
  const seen = new Set<string>()
  for (const key of actions.pinOrder) {
    const pin = byKey.get(key)
    if (pin && !seen.has(key)) { ordered.push(pin); seen.add(key) }
  }
  for (const pin of naturalPins) {
    if (!seen.has(pin.key)) ordered.push(pin)
  }

  const computeDropIndex = (cursorX: number, draggedKey: string): number => {
    const list = listRef.current
    if (!list) return 0
    const tiles = Array.from(list.querySelectorAll<HTMLElement>('[data-pin-key]'))
    let target = 0
    for (const el of tiles) {
      const key = el.dataset.pinKey
      if (!key || key === draggedKey) continue
      const rect = el.getBoundingClientRect()
      const index = Number(el.dataset.pinIndex ?? '0')
      if (cursorX > rect.left + rect.width / 2) target = index + 1
    }
    return target
  }

  const handleTileMouseDown = (event: React.MouseEvent, key: string) => {
    if (event.button !== 0) return
    const startX = event.clientX
    const startY = event.clientY
    let dragging = false
    let latestDropIndex: number | null = null

    const onMove = (e: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return
        dragging = true
        document.body.style.cursor = 'grabbing'
        setDragKey(key)
      }
      latestDropIndex = computeDropIndex(e.clientX, key)
      setDropIndex(latestDropIndex)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      if (dragging && latestDropIndex !== null) {
        const fromIndex = ordered.findIndex(p => p.key === key)
        if (fromIndex >= 0) {
          const nextKeys = ordered.map(p => p.key)
          const [moved] = nextKeys.splice(fromIndex, 1)
          const insertAt = Math.max(0, Math.min(nextKeys.length, latestDropIndex > fromIndex ? latestDropIndex - 1 : latestDropIndex))
          nextKeys.splice(insertAt, 0, moved)
          actions.setPinOrder(nextKeys)
        }
      }
      setDragKey(null)
      setDropIndex(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const draggingActive = dragKey !== null && dropIndex !== null

  return (
    <div className="border-t border-border bg-surface flex items-stretch gap-px overflow-x-auto h-8 shrink-0">
      <div ref={listRef} className="flex items-stretch gap-px shrink-0 relative">
        {ordered.map((ref, index) => (
          <React.Fragment key={ref.key}>
            {draggingActive && dropIndex === index && (
              <div className="w-0.5 shrink-0 self-stretch bg-accent-400 shadow-[0_0_6px_color-mix(in_srgb,var(--color-accent-400)_55%,transparent)]" />
            )}
            <WatchTile
              {...ref}
              pinKey={ref.key}
              index={index}
              isDragging={dragKey === ref.key}
              suppressPeek={dragKey !== null}
              onPinMouseDown={handleTileMouseDown}
            />
          </React.Fragment>
        ))}
        {draggingActive && dropIndex === ordered.length && (
          <div className="w-0.5 shrink-0 self-stretch bg-accent-400 shadow-[0_0_6px_color-mix(in_srgb,var(--color-accent-400)_55%,transparent)]" />
        )}
      </div>
      <button
        type="button"
        onClick={() => paletteEvents.emit('palette-prefix-set', '>pin')}
        className="px-3 text-xs text-text-subtle hover:text-text bg-transparent border-0 cursor-pointer shrink-0"
        title="Pin a tab to watch strip (opens command palette)"
      >
        + pin
      </button>
    </div>
  )
}

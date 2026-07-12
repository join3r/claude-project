// src/renderer/palette/PaletteList.tsx
import React from 'react'
import type { ScoredResult, EntityKind } from './types'

const SECTION_LABELS: Record<EntityKind, string> = {
  command: 'COMMANDS',
  task: 'TASKS',
  tab: 'OPEN TABS',
  project: 'PROJECTS',
  note: 'NOTES'
}
const SECTION_ORDER: EntityKind[] = ['command', 'task', 'tab', 'project', 'note']

function highlight(title: string, spans: [number, number][]): React.ReactNode[] {
  if (spans.length === 0) return [title]
  const out: React.ReactNode[] = []
  let cursor = 0
  spans.forEach(([s, e], i) => {
    if (s > cursor) out.push(title.slice(cursor, s))
    out.push(<mark key={i} className="bg-transparent text-accent font-semibold">{title.slice(s, e)}</mark>)
    cursor = e
  })
  if (cursor < title.length) out.push(title.slice(cursor))
  return out
}

interface Props {
  results: ScoredResult[]
  selectedIndex: number
  scopeLabel: string
  onSelect: (index: number) => void
  onCommit: (index: number) => void
}

export function PaletteList({ results, selectedIndex, scopeLabel, onSelect, onCommit }: Props): React.ReactElement {
  const grouped = new Map<EntityKind, { result: ScoredResult; flatIndex: number }[]>()
  results.forEach((r, i) => {
    const arr = grouped.get(r.entity.kind) ?? []
    arr.push({ result: r, flatIndex: i })
    grouped.set(r.entity.kind, arr)
  })
  if (results.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-text-subtle text-sm">No results</div>
    )
  }
  return (
    <div className="max-h-[60vh] overflow-y-auto p-2 flex flex-col gap-0.5">
      {SECTION_ORDER.map(kind => {
        const items = grouped.get(kind)
        if (!items || items.length === 0) return null
        const showScope = kind === 'task' || kind === 'note' || kind === 'tab'
        return (
          <div key={kind}>
            <div className="px-1.5 pt-2 pb-1 text-2xs font-bold tracking-[0.06em] text-text-muted">
              {SECTION_LABELS[kind]}{showScope ? ` · ${scopeLabel}` : ''}
            </div>
            {items.map(({ result, flatIndex }) => {
              const selected = flatIndex === selectedIndex
              return (
                <button
                  key={result.entity.id}
                  type="button"
                  onMouseEnter={() => onSelect(flatIndex)}
                  onClick={() => onCommit(flatIndex)}
                  className={`w-full text-left rounded-md px-1.5 py-1.5 flex items-center justify-between gap-3 text-base ${selected ? 'bg-sel' : 'bg-transparent'} text-text border-0 cursor-pointer`}
                >
                  <span className="truncate">
                    <span>▸ </span>
                    {highlight(result.entity.title, result.matchSpans)}
                  </span>
                  <span className="text-xs text-text-subtle truncate">
                    {result.entity.subtitle ?? result.entity.shortcut ?? ''}
                  </span>
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

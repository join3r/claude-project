// src/renderer/palette/PaletteFooter.tsx
import React from 'react'
import type { Prefix } from './types'

type FooterPrefix = Prefix | '*'

const DESCRIPTIONS: Record<FooterPrefix, string> = {
  '>': 'Run a command — settings, terminal, theme, panes, palette itself',
  '@': 'Switch to a task in the current project. Append * to search all projects.',
  '#': 'Open a note in the current project. Matches title and body.',
  ':': 'Jump to an already-open tab across panes and tasks.',
  '*': 'Expand search to all projects. Combine with @, #, : to scope.'
}

const LABELS: Record<FooterPrefix, string> = {
  '>': 'commands',
  '@': 'tasks',
  '#': 'notes',
  ':': 'open tabs',
  '*': 'all projects'
}

interface Props {
  activePrefix: Prefix | null
  allProjects: boolean
  onClickPrefix: (prefix: FooterPrefix) => void
}

export function PaletteFooter({ activePrefix, allProjects, onClickPrefix }: Props): React.ReactElement {
  const onlyAllProjects = activePrefix === null && allProjects
  if (activePrefix !== null) {
    return (
      <div className="px-3 py-2 text-xs text-text-subtle border-t border-hair font-mono">
        <span className="font-semibold text-text">{activePrefix}</span>{' '}
        {DESCRIPTIONS[activePrefix]}
      </div>
    )
  }
  if (onlyAllProjects) {
    return (
      <div className="px-3 py-2 text-xs text-text-subtle border-t border-hair font-mono">
        <span className="font-semibold text-text">*</span> {DESCRIPTIONS['*']}
      </div>
    )
  }
  const items: FooterPrefix[] = ['>', '@', '#', ':', '*']
  return (
    <div className="px-3 py-2 text-xs text-text-subtle border-t border-hair font-mono flex flex-wrap gap-x-4 gap-y-1">
      {items.map(p => (
        <button
          key={p}
          type="button"
          onClick={() => onClickPrefix(p)}
          title={DESCRIPTIONS[p]}
          className="cursor-pointer hover:text-text bg-transparent border-0 p-0"
        >
          <span className="font-semibold text-text">{p}</span>{' '}
          <span>{LABELS[p]}</span>
        </button>
      ))}
    </div>
  )
}

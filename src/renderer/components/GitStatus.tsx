import React, { useState, useCallback } from 'react'
import type { GitStatusResult, GitStatusEntry } from '../../shared/types'
import './GitStatus.css'

interface Props {
  gitStatus: GitStatusResult | null
  onFileClick: (filePath: string) => void
  onFileDoubleClick: (filePath: string) => void
}

const BADGE_COLORS = {
  staged: { background: '#2ea04380', color: '#4ec9b0' },
  unstaged: { background: '#e5c07b40', color: '#e5c07b' },
  untracked: { background: '#88888840', color: '#888888' },
} as const

type SectionKey = 'staged' | 'unstaged' | 'untracked'

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'staged', label: 'Staged' },
  { key: 'unstaged', label: 'Unstaged' },
  { key: 'untracked', label: 'Untracked' },
]

export default function GitStatus({ gitStatus, onFileClick, onFileDoubleClick }: Props) {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const isEmpty =
    !gitStatus ||
    (gitStatus.staged.length === 0 &&
      gitStatus.unstaged.length === 0 &&
      gitStatus.untracked.length === 0)

  if (isEmpty) {
    return (
      <div className="gitstatus">
        <div className="gitstatus-empty">No changes</div>
      </div>
    )
  }

  return (
    <div className="gitstatus">
      {SECTIONS.map(({ key, label }) => {
        const entries = gitStatus![key]
        if (entries.length === 0) return null
        const collapsed = collapsedSections.has(key)
        return (
          <div key={key} className="gitstatus-section">
            <div className="gitstatus-header" onClick={() => toggleSection(key)}>
              <span className="gitstatus-caret">{collapsed ? '\u25B6' : '\u25BC'}</span>
              {label}
              <span className="gitstatus-count">{entries.length}</span>
            </div>
            {!collapsed &&
              entries.map((entry: GitStatusEntry) => (
                <FileRow
                  key={entry.relativePath}
                  entry={entry}
                  sectionKey={key}
                  onFileClick={onFileClick}
                  onFileDoubleClick={onFileDoubleClick}
                />
              ))}
          </div>
        )
      })}
    </div>
  )
}

interface FileRowProps {
  entry: GitStatusEntry
  sectionKey: SectionKey
  onFileClick: (filePath: string) => void
  onFileDoubleClick: (filePath: string) => void
}

function FileRow({ entry, sectionKey, onFileClick, onFileDoubleClick }: FileRowProps) {
  const clickTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (clickTimer.current) {
        clearTimeout(clickTimer.current)
        clickTimer.current = null
        return
      }
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null
        onFileClick(entry.relativePath)
      }, 250)
    },
    [entry.relativePath, onFileClick]
  )

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (clickTimer.current) {
        clearTimeout(clickTimer.current)
        clickTimer.current = null
      }
      onFileDoubleClick(entry.relativePath)
    },
    [entry.relativePath, onFileDoubleClick]
  )

  const colors = BADGE_COLORS[sectionKey]

  return (
    <div
      className="gitstatus-file"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <span
        className="gitstatus-badge"
        style={{ background: colors.background, color: colors.color }}
      >
        {entry.status}
      </span>
      <span className="gitstatus-path">{entry.relativePath}</span>
    </div>
  )
}

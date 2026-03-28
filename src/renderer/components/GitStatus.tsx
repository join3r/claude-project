import React, { useState, useCallback, useRef, useEffect } from 'react'
import type { GitStatusResult, GitStatusEntry } from '../../shared/types'
import './GitStatus.css'

interface Props {
  gitStatus: GitStatusResult | null
  projectDir: string
  onFileClick: (filePath: string) => void
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

export default function GitStatus({ gitStatus, projectDir, onFileClick }: Props) {
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
    }
  }, [])

  const showFeedback = useCallback((type: 'success' | 'error', text: string) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
    setFeedback({ type, text })
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 4000)
  }, [])

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

  const refreshStatus = useCallback(() => {
    window.dispatchEvent(new CustomEvent('file-saved'))
  }, [])

  const handleStage = useCallback(async (files: string[]) => {
    if (busy || files.length === 0) return
    setBusy(true)
    try {
      const result = await window.api.fbGitStage(projectDir, files)
      if (!result.success) showFeedback('error', result.message)
      refreshStatus()
    } catch {
      showFeedback('error', 'Stage failed')
    } finally {
      setBusy(false)
    }
  }, [busy, projectDir, showFeedback, refreshStatus])

  const handleUnstage = useCallback(async (files: string[]) => {
    if (busy || files.length === 0) return
    setBusy(true)
    try {
      const result = await window.api.fbGitUnstage(projectDir, files)
      if (!result.success) showFeedback('error', result.message)
      refreshStatus()
    } catch {
      showFeedback('error', 'Unstage failed')
    } finally {
      setBusy(false)
    }
  }, [busy, projectDir, showFeedback, refreshStatus])

  const handlePull = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.fbGitPull(projectDir)
      showFeedback(result.success ? 'success' : 'error', result.message)
      if (result.success) refreshStatus()
    } catch {
      showFeedback('error', 'Pull failed')
    } finally {
      setBusy(false)
    }
  }, [busy, projectDir, showFeedback, refreshStatus])

  const handleCommit = useCallback(async () => {
    if (busy || !commitMsg.trim()) return
    setBusy(true)
    try {
      const result = await window.api.fbGitCommit(projectDir, commitMsg)
      showFeedback(result.success ? 'success' : 'error', result.message)
      if (result.success) {
        setCommitMsg('')
        refreshStatus()
      }
    } catch {
      showFeedback('error', 'Commit failed')
    } finally {
      setBusy(false)
    }
  }, [busy, projectDir, commitMsg, showFeedback, refreshStatus])

  const handlePush = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.fbGitPush(projectDir)
      showFeedback(result.success ? 'success' : 'error', result.message)
      if (result.success) refreshStatus()
    } catch {
      showFeedback('error', 'Push failed')
    } finally {
      setBusy(false)
    }
  }, [busy, projectDir, showFeedback, refreshStatus])

  const isEmpty =
    !gitStatus ||
    (gitStatus.staged.length === 0 &&
      gitStatus.unstaged.length === 0 &&
      gitStatus.untracked.length === 0)

  const hasStagedFiles = gitStatus && gitStatus.staged.length > 0

  const handleSectionAction = useCallback((key: SectionKey) => {
    if (!gitStatus) return
    const files = gitStatus[key].map(e => e.relativePath)
    if (key === 'staged') {
      handleUnstage(files)
    } else {
      handleStage(files)
    }
  }, [gitStatus, handleStage, handleUnstage])

  const handleFileAction = useCallback((key: SectionKey, filePath: string) => {
    if (key === 'staged') {
      handleUnstage([filePath])
    } else {
      handleStage([filePath])
    }
  }, [handleStage, handleUnstage])

  return (
    <div className="gitstatus">
      <div className="gitstatus-actions">
        <div className="gitstatus-actions-row">
          <button className="gitstatus-btn" onClick={handlePull} disabled={busy} title="Git Pull">
            {busy ? '...' : 'Pull'}
          </button>
          <button className="gitstatus-btn" onClick={handlePush} disabled={busy} title="Git Push">
            Push
          </button>
        </div>
        <div className="gitstatus-commit-row">
          <input
            className="gitstatus-commit-input"
            type="text"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCommit() }}
            disabled={busy}
          />
          <button
            className="gitstatus-btn"
            onClick={handleCommit}
            disabled={busy || !commitMsg.trim() || !hasStagedFiles}
            title="Commit staged files"
          >
            Commit
          </button>
        </div>
        {feedback && (
          <div className={`gitstatus-feedback gitstatus-feedback-${feedback.type}`}>
            {feedback.text}
          </div>
        )}
      </div>
      {isEmpty ? (
        <div className="gitstatus-empty">No changes</div>
      ) : (
        SECTIONS.map(({ key, label }) => {
          const entries = gitStatus![key]
          if (entries.length === 0) return null
          const collapsed = collapsedSections.has(key)
          return (
            <div key={key} className="gitstatus-section">
              <div className="gitstatus-header" onClick={() => toggleSection(key)}>
                <span className="gitstatus-caret">{collapsed ? '\u25B6' : '\u25BC'}</span>
                {label}
                <span className="gitstatus-count">{entries.length}</span>
                <button
                  className="gitstatus-stage-btn"
                  title={key === 'staged' ? 'Unstage All' : 'Stage All'}
                  disabled={busy}
                  onClick={(e) => { e.stopPropagation(); handleSectionAction(key) }}
                >
                  {key === 'staged' ? '\u2212' : '+'}
                </button>
              </div>
              {!collapsed &&
                entries.map((entry: GitStatusEntry) => (
                  <FileRow
                    key={entry.relativePath}
                    entry={entry}
                    sectionKey={key}
                    busy={busy}
                    onFileClick={onFileClick}
                    onAction={handleFileAction}
                  />
                ))}
            </div>
          )
        })
      )}
    </div>
  )
}

interface FileRowProps {
  entry: GitStatusEntry
  sectionKey: SectionKey
  busy: boolean
  onFileClick: (filePath: string) => void
  onAction: (sectionKey: SectionKey, filePath: string) => void
}

function FileRow({ entry, sectionKey, busy, onFileClick, onAction }: FileRowProps) {
  const colors = BADGE_COLORS[sectionKey]

  return (
    <div
      className="gitstatus-file"
      onClick={() => onFileClick(entry.relativePath)}
    >
      <span
        className="gitstatus-badge"
        style={{ background: colors.background, color: colors.color }}
      >
        {entry.status}
      </span>
      <span className="gitstatus-path">{entry.relativePath}</span>
      <button
        className="gitstatus-stage-btn gitstatus-file-action"
        title={sectionKey === 'staged' ? 'Unstage' : 'Stage'}
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); onAction(sectionKey, entry.relativePath) }}
      >
        {sectionKey === 'staged' ? '\u2212' : '+'}
      </button>
    </div>
  )
}

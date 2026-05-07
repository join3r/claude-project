import React, { useState, useCallback, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { GitStatusResult, GitStatusEntry } from '../../shared/types'

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

  const handleDiscard = useCallback(async (files: string[]) => {
    if (busy || files.length === 0) return
    setBusy(true)
    try {
      const result = await window.api.fbGitDiscard(projectDir, files)
      if (result.success) {
        showFeedback('success', result.message)
      } else {
        showFeedback('error', result.message)
      }
      refreshStatus()
    } catch {
      showFeedback('error', 'Discard failed')
    } finally {
      setBusy(false)
    }
  }, [busy, projectDir, showFeedback, refreshStatus])

  const handleStageAll = useCallback(() => {
    if (!gitStatus) return
    const files = [
      ...gitStatus.unstaged.map(e => e.relativePath),
      ...gitStatus.untracked.map(e => e.relativePath),
    ]
    handleStage(files)
  }, [gitStatus, handleStage])

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
  const hasUnstagedOrUntracked = gitStatus &&
    (gitStatus.unstaged.length > 0 || gitStatus.untracked.length > 0)

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
    <div className="overflow-y-auto text-[13px]">
      <div className="p-2 border-b border-border flex flex-col gap-1.5">
        <div className="flex gap-1">
          <button className="bg-surface-2 text-text border border-border rounded-sm px-2.5 py-0.5 text-[11px] cursor-pointer leading-snug whitespace-nowrap hover:enabled:bg-surface-3 disabled:opacity-40 disabled:cursor-default" onClick={handlePull} disabled={busy} title="Git Pull">
            {busy ? '...' : 'Pull'}
          </button>
          <button className="bg-surface-2 text-text border border-border rounded-sm px-2.5 py-0.5 text-[11px] cursor-pointer leading-snug whitespace-nowrap hover:enabled:bg-surface-3 disabled:opacity-40 disabled:cursor-default" onClick={handlePush} disabled={busy} title="Git Push">
            Push
          </button>
          {hasUnstagedOrUntracked && (
            <button
              className="ml-auto bg-surface-2 text-text border border-border rounded-sm px-2.5 py-0.5 text-[11px] cursor-pointer leading-snug whitespace-nowrap hover:enabled:bg-surface-3 disabled:opacity-40 disabled:cursor-default"
              onClick={handleStageAll}
              disabled={busy}
              title="Stage all unstaged and untracked files"
            >
              Stage All
            </button>
          )}
        </div>
        <div className="flex gap-1">
          <input
            className="flex-1 min-w-0 bg-surface-2 text-text border border-border rounded-sm px-1.5 py-0.5 text-[11px] outline-none focus:border-border-focus placeholder:text-text-muted"
            type="text"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCommit() }}
            disabled={busy}
          />
          <button
            className="bg-surface-2 text-text border border-border rounded-sm px-2.5 py-0.5 text-[11px] cursor-pointer leading-snug whitespace-nowrap hover:enabled:bg-surface-3 disabled:opacity-40 disabled:cursor-default"
            onClick={handleCommit}
            disabled={busy || !commitMsg.trim() || !hasStagedFiles}
            title="Commit staged files"
          >
            Commit
          </button>
        </div>
        {feedback && (
          <div className={`text-[11px] px-1 py-0.5 rounded-sm overflow-hidden text-ellipsis whitespace-nowrap ${feedback.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
            {feedback.text}
          </div>
        )}
      </div>
      {isEmpty ? (
        <div className="flex items-center justify-center p-6 text-text-muted">No changes</div>
      ) : (
        SECTIONS.map(({ key, label }) => {
          const entries = gitStatus![key]
          if (entries.length === 0) return null
          const collapsed = collapsedSections.has(key)
          return (
            <div key={key} className="mb-1">
              <div className="group flex items-center px-2 py-1 cursor-pointer font-semibold text-[11px] uppercase text-text-muted select-none hover:bg-surface-2" onClick={() => toggleSection(key)}>
                <span className="w-4 flex items-center justify-center text-text-muted shrink-0">
                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </span>
                {label}
                <span className="ml-1.5 font-normal opacity-70">{entries.length}</span>
                <button
                  className="ml-auto bg-transparent border border-border rounded-sm text-text-muted cursor-pointer text-[13px] font-semibold leading-none w-5 h-5 inline-flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hover:enabled:bg-surface-3 hover:enabled:text-text disabled:opacity-0 disabled:cursor-default"
                  title={key === 'staged' ? 'Unstage All' : 'Stage All'}
                  disabled={busy}
                  onClick={(e) => { e.stopPropagation(); handleSectionAction(key) }}
                >
                  {key === 'staged' ? '−' : '+'}
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
                    onDiscard={key === 'unstaged' ? handleDiscard : undefined}
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
  onDiscard?: (files: string[]) => void
}

function FileRow({ entry, sectionKey, busy, onFileClick, onAction, onDiscard }: FileRowProps) {
  const colors = BADGE_COLORS[sectionKey]
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  const handleDiscardClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onDiscard) return
    if (!confirmDiscard) {
      setConfirmDiscard(true)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = setTimeout(() => setConfirmDiscard(false), 3000)
    } else {
      setConfirmDiscard(false)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      onDiscard([entry.relativePath])
    }
  }, [onDiscard, confirmDiscard, entry.relativePath])

  return (
    <div
      className="group flex items-center px-2 pl-6 py-0.5 cursor-pointer gap-2 select-none hover:bg-surface-2"
      onClick={() => onFileClick(entry.relativePath)}
    >
      <span
        className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-sm text-[11px] font-semibold shrink-0"
        style={{ background: colors.background, color: colors.color }}
      >
        {entry.status}
      </span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{entry.relativePath}</span>
      {onDiscard && (
        <button
          className={`bg-transparent border border-border rounded-sm text-text-muted cursor-pointer text-[11px] leading-none w-5 h-5 inline-flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hover:enabled:bg-red-400/25 hover:enabled:text-red-400 hover:enabled:border-red-400 disabled:opacity-0 disabled:cursor-default${confirmDiscard ? ' !opacity-100 bg-red-400/25 text-red-400 border-red-400 font-bold' : ''}`}
          title={confirmDiscard ? 'Click again to confirm discard' : 'Discard changes'}
          disabled={busy}
          onClick={handleDiscardClick}
        >
          {confirmDiscard ? '?' : '✕'}
        </button>
      )}
      <button
        className="ml-auto bg-transparent border border-border rounded-sm text-text-muted cursor-pointer text-[13px] font-semibold leading-none w-5 h-5 inline-flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hover:enabled:bg-surface-3 hover:enabled:text-text disabled:opacity-0 disabled:cursor-default"
        title={sectionKey === 'staged' ? 'Unstage' : 'Stage'}
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); onAction(sectionKey, entry.relativePath) }}
      >
        {sectionKey === 'staged' ? '−' : '+'}
      </button>
    </div>
  )
}

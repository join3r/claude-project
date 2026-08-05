import React, { useState, useCallback, useRef, useEffect } from 'react'
import { ChevronRight } from 'lucide-react'
import type { GitStatusResult, GitStatusEntry } from '../../shared/types'
import { gitEntryPaths } from '../../shared/types'
import { LinkBtn } from './ui'

interface Props {
  gitStatus: GitStatusResult | null
  projectDir: string
  onFileClick: (filePath: string) => void
}

const BADGE_CLASSES = {
  staged: 'bg-success/20 text-success',
  unstaged: 'bg-warn/20 text-warn',
  untracked: 'bg-surface-3 text-text-muted',
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
      ...gitStatus.unstaged.flatMap(gitEntryPaths),
      ...gitStatus.untracked.flatMap(gitEntryPaths),
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
    const files = gitStatus[key].flatMap(gitEntryPaths)
    if (key === 'staged') {
      handleUnstage(files)
    } else {
      handleStage(files)
    }
  }, [gitStatus, handleStage, handleUnstage])

  const handleFileAction = useCallback((key: SectionKey, entry: GitStatusEntry) => {
    const files = gitEntryPaths(entry)
    if (key === 'staged') {
      handleUnstage(files)
    } else {
      handleStage(files)
    }
  }, [handleStage, handleUnstage])

  return (
    <div className="overflow-y-auto text-base">
      <div className="p-2 border-b border-hair flex flex-col gap-1.5">
        <div className="flex items-center gap-3 px-0.5">
          <LinkBtn onClick={handlePull} disabled={busy} title="Git Pull">{busy ? '…' : 'Pull'}</LinkBtn>
          <LinkBtn onClick={handlePush} disabled={busy} title="Git Push">Push</LinkBtn>
          {hasUnstagedOrUntracked && (
            <span className="ml-auto">
              <LinkBtn onClick={handleStageAll} disabled={busy} title="Stage all unstaged and untracked files">
                Stage all
              </LinkBtn>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 min-w-0 h-(--ctl-h-sm) bg-field text-text border border-border rounded-md px-2 text-sm outline-none focus:border-border-focus placeholder:text-text-subtle"
            type="text"
            placeholder="Commit message…"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCommit() }}
            disabled={busy}
          />
          <LinkBtn
            onClick={handleCommit}
            disabled={busy || !commitMsg.trim() || !hasStagedFiles}
            title="Commit staged files"
          >
            Commit
          </LinkBtn>
        </div>
        {feedback && (
          <div className={`text-xs px-1 py-0.5 rounded-sm overflow-hidden text-ellipsis whitespace-nowrap ${feedback.type === 'success' ? 'text-success' : 'text-danger'}`}>
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
              <div className="group flex items-center px-2 py-1 cursor-pointer text-base font-normal text-text-muted hover:text-text select-none transition-colors duration-(--motion-fast)" onClick={() => toggleSection(key)}>
                <span className="w-4 flex items-center justify-center text-text-muted shrink-0">
                  <ChevronRight size={12} className={`transition-transform duration-(--motion-fast) ${collapsed ? '' : 'rotate-90'}`} />
                </span>
                {label}
                <span className="ml-1.5 opacity-70">({entries.length})</span>
                <button
                  className="ml-auto bg-transparent border-0 rounded-md text-text-muted cursor-pointer text-base font-semibold leading-none size-5 inline-flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-(--motion-fast) hover:enabled:bg-sel hover:enabled:text-text disabled:opacity-0 disabled:cursor-default"
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
  onAction: (sectionKey: SectionKey, entry: GitStatusEntry) => void
  onDiscard?: (files: string[]) => void
}

function FileRow({ entry, sectionKey, busy, onFileClick, onAction, onDiscard }: FileRowProps) {
  const badgeCls = BADGE_CLASSES[sectionKey]
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
      onDiscard(gitEntryPaths(entry))
    }
  }, [onDiscard, confirmDiscard, entry])

  return (
    <div
      className="group flex items-center px-2 pl-6 py-0.5 cursor-pointer gap-2 select-none hover:bg-surface-3 transition-colors duration-(--motion-fast)"
      onClick={() => onFileClick(entry.relativePath)}
    >
      <span
        className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded-sm text-xs font-semibold shrink-0 ${badgeCls}`}
      >
        {entry.status}
      </span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap" title={entry.origPath ? `${entry.origPath} → ${entry.relativePath}` : entry.relativePath}>
        {entry.relativePath}
        {entry.origPath && <span className="text-text-muted"> ← {entry.origPath}</span>}
      </span>
      {onDiscard && (
        <button
          className={`bg-transparent border-0 rounded-md text-text-muted cursor-pointer text-xs leading-none size-5 inline-flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-(--motion-fast) hover:enabled:bg-danger/15 hover:enabled:text-danger disabled:opacity-0 disabled:cursor-default${confirmDiscard ? ' !opacity-100 bg-danger/15 text-danger font-bold' : ''}`}
          title={confirmDiscard ? 'Click again to confirm discard' : 'Discard changes'}
          disabled={busy}
          onClick={handleDiscardClick}
        >
          {confirmDiscard ? '?' : '✕'}
        </button>
      )}
      <button
        className="ml-auto bg-transparent border-0 rounded-md text-text-muted cursor-pointer text-base font-semibold leading-none size-5 inline-flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-(--motion-fast) hover:enabled:bg-sel hover:enabled:text-text disabled:opacity-0 disabled:cursor-default"
        title={sectionKey === 'staged' ? 'Unstage' : 'Stage'}
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); onAction(sectionKey, entry) }}
      >
        {sectionKey === 'staged' ? '−' : '+'}
      </button>
    </div>
  )
}

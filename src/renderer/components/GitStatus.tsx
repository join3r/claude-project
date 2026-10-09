import React, { useState, useCallback, useRef, useEffect } from 'react'
import { ChevronRight, GitBranch } from 'lucide-react'
import type { GitRepoStatus, GitStatusResult, GitStatusEntry } from '../../shared/types'
import { gitEntryPaths } from '../../shared/types'
import { ContextMenu, LinkBtn, type ContextMenuItem } from './ui'
import { revealInFolderLabel } from '../utils/revealLabel'

interface Props {
  gitStatus: GitStatusResult | null
  projectDir: string
  /** Routes the git calls to a DevTool server's project. */
  projectId?: string
  onFileClick: (filePath: string) => void
  /** Reveal in Finder: only for folders on this computer (not a DevTool server's). */
  canReveal?: boolean
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

const EMPTY_ROOT: GitRepoStatus = { path: '', staged: [], unstaged: [], untracked: [] }

/**
 * One block per repository. A project that is a single repo looks exactly as
 * before; one with nested repos (or only nested repos) gets a header per repo,
 * each with its own Pull/Push and commit box.
 */
export default function GitStatus({ gitStatus, projectDir, projectId, onFileClick, canReveal = true }: Props) {
  const repos = gitStatus ? gitStatus.repos : [EMPTY_ROOT]
  if (repos.length === 0) {
    return <div className="flex items-center justify-center p-6 text-text-muted text-base">Not a git repository</div>
  }
  const showHeaders = !(repos.length === 1 && repos[0].path === '')
  const rootName = projectDir.split(/[\\/]/).filter(Boolean).pop() ?? projectDir
  return (
    <div className="overflow-y-auto text-base">
      {repos.map((repo) => (
        <RepoPanel
          key={repo.path}
          repo={repo}
          title={showHeaders ? (repo.path || rootName) : null}
          projectDir={projectDir}
          projectId={projectId}
          onFileClick={onFileClick}
          canReveal={canReveal}
        />
      ))}
    </div>
  )
}

interface RepoPanelProps {
  repo: GitRepoStatus
  /** Header label, or null for a lone root repo (no header). */
  title: string | null
  projectDir: string
  projectId?: string
  onFileClick: (filePath: string) => void
  canReveal: boolean
}

function RepoPanel({ repo, title, projectDir, projectId, onFileClick, canReveal }: RepoPanelProps) {
  const [repoCollapsed, setRepoCollapsed] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; sectionKey: SectionKey; entry: GitStatusEntry } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
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
      const result = await window.api.fbGitStage(projectDir, repo.path, files, projectId)
      if (!result.success) showFeedback('error', result.message)
      refreshStatus()
    } catch {
      showFeedback('error', 'Stage failed')
    } finally {
      setBusy(false)
    }
  }, [busy, projectDir, repo.path, showFeedback, refreshStatus, projectId])

  const handleUnstage = useCallback(async (files: string[]) => {
    if (busy || files.length === 0) return
    setBusy(true)
    try {
      const result = await window.api.fbGitUnstage(projectDir, repo.path, files, projectId)
      if (!result.success) showFeedback('error', result.message)
      refreshStatus()
    } catch {
      showFeedback('error', 'Unstage failed')
    } finally {
      setBusy(false)
    }
  }, [busy, projectDir, repo.path, showFeedback, refreshStatus, projectId])

  const handleDiscard = useCallback(async (files: string[]) => {
    if (busy || files.length === 0) return
    setBusy(true)
    try {
      const result = await window.api.fbGitDiscard(projectDir, repo.path, files, projectId)
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
  }, [busy, projectDir, repo.path, showFeedback, refreshStatus, projectId])

  const handleStageAll = useCallback(() => {
    const files = [
      ...repo.unstaged.flatMap(gitEntryPaths),
      ...repo.untracked.flatMap(gitEntryPaths),
    ]
    handleStage(files)
  }, [repo, handleStage])

  const handlePull = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.fbGitPull(projectDir, repo.path, projectId)
      showFeedback(result.success ? 'success' : 'error', result.message)
      if (result.success) refreshStatus()
    } catch {
      showFeedback('error', 'Pull failed')
    } finally {
      setBusy(false)
    }
  }, [busy, projectDir, repo.path, showFeedback, refreshStatus, projectId])

  const handleCommit = useCallback(async () => {
    if (busy || !commitMsg.trim()) return
    setBusy(true)
    try {
      const result = await window.api.fbGitCommit(projectDir, repo.path, commitMsg, projectId)
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
  }, [busy, projectDir, repo.path, commitMsg, showFeedback, refreshStatus, projectId])

  const handlePush = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.fbGitPush(projectDir, repo.path, projectId)
      showFeedback(result.success ? 'success' : 'error', result.message)
      if (result.success) refreshStatus()
    } catch {
      showFeedback('error', 'Push failed')
    } finally {
      setBusy(false)
    }
  }, [busy, projectDir, repo.path, showFeedback, refreshStatus, projectId])

  const changeCount = repo.staged.length + repo.unstaged.length + repo.untracked.length
  const isEmpty = changeCount === 0

  const hasStagedFiles = repo.staged.length > 0
  const hasUnstagedOrUntracked = repo.unstaged.length > 0 || repo.untracked.length > 0

  const handleSectionAction = useCallback((key: SectionKey) => {
    const files = repo[key].flatMap(gitEntryPaths)
    if (key === 'staged') {
      handleUnstage(files)
    } else {
      handleStage(files)
    }
  }, [repo, handleStage, handleUnstage])

  const handleFileAction = useCallback((key: SectionKey, entry: GitStatusEntry) => {
    const files = gitEntryPaths(entry)
    if (key === 'staged') {
      handleUnstage(files)
    } else {
      handleStage(files)
    }
  }, [handleStage, handleUnstage])

  return (
    <div className={title !== null ? 'border-b border-hair' : undefined}>
      {title !== null && (
        <div
          className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer select-none bg-surface-2 text-text hover:bg-surface-3 transition-colors duration-(--motion-fast)"
          onClick={() => setRepoCollapsed(c => !c)}
          title={repo.path ? `${projectDir}/${repo.path}` : projectDir}
        >
          <ChevronRight size={12} className={`shrink-0 text-text-muted transition-transform duration-(--motion-fast) ${repoCollapsed ? '' : 'rotate-90'}`} />
          <GitBranch size={12} className="shrink-0 text-text-muted" />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap font-medium">{title}</span>
          {changeCount > 0 && <span className="text-text-muted opacity-70">({changeCount})</span>}
        </div>
      )}
      {!repoCollapsed && repo.skipped && (
        <div className="px-3 py-2 text-sm text-text-muted">{repo.skipped}</div>
      )}
      {!repoCollapsed && !repo.skipped && (<>
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
        <div className={`flex items-center justify-center text-text-muted ${title !== null ? 'p-3' : 'p-6'}`}>No changes</div>
      ) : (
        SECTIONS.map(({ key, label }) => {
          const entries = repo[key]
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
                    repoPath={repo.path}
                    sectionKey={key}
                    busy={busy}
                    onFileClick={onFileClick}
                    onAction={handleFileAction}
                    onDiscard={key === 'unstaged' ? handleDiscard : undefined}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ x: e.clientX, y: e.clientY, sectionKey: key, entry })
                    }}
                  />
                ))}
            </div>
          )
        })
      )}
      </>)}
      <ContextMenu menu={menu} onClose={closeMenu} items={menu ? fileMenuItems(menu.sectionKey, menu.entry) : []} />
    </div>
  )

  function fileMenuItems(sectionKey: SectionKey, entry: GitStatusEntry): ContextMenuItem[] {
    const name = entry.relativePath.split('/').pop() ?? entry.relativePath
    const items: ContextMenuItem[] = [
      { label: 'Open', onSelect: () => onFileClick(entry.relativePath) },
      { label: sectionKey === 'staged' ? 'Unstage' : 'Stage', disabled: busy, onSelect: () => { void handleFileAction(sectionKey, entry) } }
    ]
    // A deleted file has nothing on disk to show.
    if (entry.status !== 'D' && canReveal) {
      items.push({
        label: revealInFolderLabel(),
        onSelect: () => {
          window.api.revealInFolder(projectDir, entry.relativePath, projectId).catch((err: unknown) => {
            showFeedback('error', err instanceof Error ? err.message : String(err))
          })
        }
      })
    }
    if (sectionKey === 'unstaged') {
      items.push({
        label: 'Discard changes…',
        danger: true,
        disabled: busy,
        onSelect: () => {
          if (window.confirm(`Discard your changes to "${name}"? This can't be undone.`)) void handleDiscard(gitEntryPaths(entry))
        }
      })
    }
    return items
  }
}

interface FileRowProps {
  entry: GitStatusEntry
  /** The repo the entry belongs to; rows show paths relative to it. */
  repoPath: string
  sectionKey: SectionKey
  busy: boolean
  onFileClick: (filePath: string) => void
  onAction: (sectionKey: SectionKey, entry: GitStatusEntry) => void
  onDiscard?: (files: string[]) => void
  onContextMenu: (e: React.MouseEvent) => void
}

/** A project-relative path shown relative to its repo. */
function repoRelative(repoPath: string, filePath: string): string {
  return repoPath && filePath.startsWith(`${repoPath}/`) ? filePath.slice(repoPath.length + 1) : filePath
}

function FileRow({ entry, repoPath, sectionKey, busy, onFileClick, onAction, onDiscard, onContextMenu }: FileRowProps) {
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
      onContextMenu={onContextMenu}
    >
      <span
        className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded-sm text-xs font-semibold shrink-0 ${badgeCls}`}
      >
        {entry.status}
      </span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap" title={entry.origPath ? `${entry.origPath} → ${entry.relativePath}` : entry.relativePath}>
        {repoRelative(repoPath, entry.relativePath)}
        {entry.origPath && <span className="text-text-muted"> ← {repoRelative(repoPath, entry.origPath)}</span>}
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

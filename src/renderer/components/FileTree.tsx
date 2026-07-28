import React, { useState, useEffect, useCallback } from 'react'
import type { DirectoryEntry, GitStatusResult, GitFileStatus } from '../../shared/types'
import { ChevronRight, Folder, FileText } from 'lucide-react'
import { FILE_BROWSER_REFRESH_MS } from '../hooks/fileBrowserRefresh'

interface Props {
  projectDir: string
  gitStatus: GitStatusResult | null
  onFileClick: (filePath: string) => void
}

type StatusColor = 'var(--color-danger)' | 'var(--color-warn)' | 'var(--color-success)' | undefined

function statusToColor(status: GitFileStatus): StatusColor {
  switch (status) {
    case 'D':
      return 'var(--color-danger)'
    case 'M':
      return 'var(--color-warn)'
    case 'A':
    case '?':
      return 'var(--color-success)'
    default:
      return undefined
  }
}

function colorSeverity(color: StatusColor): number {
  if (color === 'var(--color-danger)') return 3
  if (color === 'var(--color-warn)') return 2
  if (color === 'var(--color-success)') return 1
  return 0
}

function buildGitMap(gitStatus: GitStatusResult | null): Map<string, GitFileStatus> {
  const map = new Map<string, GitFileStatus>()
  if (!gitStatus) return map
  for (const entry of gitStatus.staged) {
    map.set(entry.relativePath, entry.status)
  }
  for (const entry of gitStatus.unstaged) {
    map.set(entry.relativePath, entry.status)
  }
  for (const entry of gitStatus.untracked) {
    map.set(entry.relativePath, entry.status)
  }
  return map
}

function getDirectoryColor(
  dirPath: string,
  gitMap: Map<string, GitFileStatus>
): StatusColor {
  let maxSeverity = 0
  let maxColor: StatusColor = undefined
  const prefix = dirPath === '' ? '' : dirPath + '/'
  for (const [filePath, status] of gitMap) {
    if (filePath.startsWith(prefix)) {
      const color = statusToColor(status)
      const severity = colorSeverity(color)
      if (severity > maxSeverity) {
        maxSeverity = severity
        maxColor = color
      }
    }
  }
  return maxColor
}

function parentDirOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/')
  return slash === -1 ? '' : relativePath.slice(0, slash)
}

/** Listings are sorted deterministically by main, so order-sensitive compare is safe. */
function sameListing(a: DirectoryEntry[], b: DirectoryEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].relativePath !== b[i].relativePath || a[i].type !== b[i].type) return false
  }
  return true
}

interface TreeNodeProps {
  entry: DirectoryEntry
  level: number
  projectDir: string
  expandedDirs: Set<string>
  childrenCache: Record<string, DirectoryEntry[]>
  loadingDirs: Set<string>
  directoryErrors: Record<string, string>
  gitMap: Map<string, GitFileStatus>
  onToggleDir: (relativePath: string) => void
  onFileClick: (filePath: string) => void
}

function TreeNode({
  entry,
  level,
  projectDir,
  expandedDirs,
  childrenCache,
  loadingDirs,
  directoryErrors,
  gitMap,
  onToggleDir,
  onFileClick,
}: TreeNodeProps) {
  const isDirectory = entry.type === 'directory'
  const isExpanded = expandedDirs.has(entry.relativePath)
  const children = childrenCache[entry.relativePath]
  const isLoading = loadingDirs.has(entry.relativePath)
  const loadError = directoryErrors[entry.relativePath]

  let color: string | undefined
  if (isDirectory) {
    color = getDirectoryColor(entry.relativePath, gitMap)
  } else {
    const status = gitMap.get(entry.relativePath)
    color = status ? statusToColor(status) : undefined
  }

  const handleClick = useCallback(() => {
    if (isDirectory) {
      onToggleDir(entry.relativePath)
      return
    }
    onFileClick(entry.relativePath)
  }, [isDirectory, entry.relativePath, onToggleDir, onFileClick])

  return (
    <>
      <div
        className="flex items-center px-2 py-0.5 cursor-pointer whitespace-nowrap select-none hover:bg-surface-3 transition-colors duration-(--motion-fast)"
        style={{ paddingLeft: 8 + level * 16, color: color || 'var(--color-text)' }}
        onClick={handleClick}
      >
        <span className="w-4 flex items-center justify-center shrink-0 text-text-muted">
          {isDirectory ? <ChevronRight size={12} className={`transition-transform duration-(--motion-fast) ${isExpanded ? 'rotate-90' : ''}`} /> : null}
        </span>
        {isDirectory
          ? <Folder size={12} className="mr-1.5 text-text-muted shrink-0" />
          : <FileText size={12} className="mr-1.5 text-text-muted shrink-0" />
        }
        <span className="overflow-hidden text-ellipsis" style={{ color: color }}>{entry.name}</span>
      </div>
      {isDirectory && isExpanded && (
        <>
          {isLoading && (
            <div className="text-text-muted px-2 py-0.5 italic" style={{ paddingLeft: 8 + (level + 1) * 16 }}>
              Loading...
            </div>
          )}
          {loadError && (
            <div
              className="text-danger px-2 py-0.5"
              style={{ paddingLeft: 8 + (level + 1) * 16 }}
              title={loadError}
            >
              Unable to read folder
            </div>
          )}
          {children &&
            children.map((child) => (
              <TreeNode
                key={child.relativePath}
                entry={child}
                level={level + 1}
                projectDir={projectDir}
                expandedDirs={expandedDirs}
                childrenCache={childrenCache}
                loadingDirs={loadingDirs}
                directoryErrors={directoryErrors}
                gitMap={gitMap}
                onToggleDir={onToggleDir}
                onFileClick={onFileClick}
              />
            ))}
        </>
      )}
    </>
  )
}

export default function FileTree({ projectDir, gitStatus, onFileClick }: Props) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [childrenCache, setChildrenCache] = useState<Record<string, DirectoryEntry[]>>({})
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [directoryErrors, setDirectoryErrors] = useState<Record<string, string>>({})
  const directoryVersionRef = React.useRef(0)
  const expandedDirsRef = React.useRef(expandedDirs)
  expandedDirsRef.current = expandedDirs
  const childrenCacheRef = React.useRef(childrenCache)
  childrenCacheRef.current = childrenCache

  const gitMap = React.useMemo(() => buildGitMap(gitStatus), [gitStatus])

  const fetchDirectory = useCallback(
    async (relativePath: string) => {
      const directoryVersion = directoryVersionRef.current
      setLoadingDirs((prev) => new Set(prev).add(relativePath))
      setDirectoryErrors((prev) => {
        if (!(relativePath in prev)) return prev
        const next = { ...prev }
        delete next[relativePath]
        return next
      })
      try {
        const entries = await window.api.fbReadDirectory(projectDir, relativePath)
        if (directoryVersion !== directoryVersionRef.current) return
        setChildrenCache((prev) => ({ ...prev, [relativePath]: entries }))
      } catch (error) {
        if (directoryVersion !== directoryVersionRef.current) return
        const message = error instanceof Error ? error.message : String(error)
        setDirectoryErrors((prev) => ({ ...prev, [relativePath]: message }))
      } finally {
        if (directoryVersion !== directoryVersionRef.current) return
        setLoadingDirs((prev) => {
          const next = new Set(prev)
          next.delete(relativePath)
          return next
        })
      }
    },
    [projectDir]
  )

  // Silent re-read of every directory currently on screen (root + expanded).
  // Nothing here touches loadingDirs, so a poll never flashes "Loading..." over
  // a tree the user is looking at.
  const refreshVisibleDirectories = useCallback(async () => {
    if (!projectDir) return
    const directoryVersion = directoryVersionRef.current
    const paths = ['', ...expandedDirsRef.current]

    const results = await Promise.all(
      paths.map(async (relativePath) => {
        try {
          return { relativePath, entries: await window.api.fbReadDirectory(projectDir, relativePath) }
        } catch {
          return { relativePath, entries: null }
        }
      })
    )
    if (directoryVersion !== directoryVersionRef.current) return

    const refreshed = new Map<string, DirectoryEntry[]>()
    for (const { relativePath, entries } of results) {
      if (entries) refreshed.set(relativePath, entries)
    }

    // A directory that vanished from its (successfully re-read) parent is gone.
    // Its own read failing isn't proof — that could be a transient EACCES.
    const liveDirs = new Set<string>()
    for (const entries of refreshed.values()) {
      for (const entry of entries) {
        if (entry.type === 'directory') liveDirs.add(entry.relativePath)
      }
    }
    // Stale roots have to be gathered from everything we track, not just from
    // `refreshed` — a deleted directory's own read fails, so it never lands
    // there, and its cached descendants would otherwise survive the prune.
    const tracked = new Set<string>([
      ...paths,
      ...expandedDirsRef.current,
      ...Object.keys(childrenCacheRef.current)
    ])
    const staleRoots = [...tracked].filter((relativePath) => {
      if (relativePath === '') return false
      const parent = parentDirOf(relativePath)
      return refreshed.has(parent) && !liveDirs.has(relativePath)
    })
    const isStaleOrOrphaned = (relativePath: string): boolean =>
      staleRoots.some(root => relativePath === root || relativePath.startsWith(root + '/'))

    setChildrenCache((prev) => {
      const next = { ...prev }
      let changed = false
      for (const [relativePath, entries] of refreshed) {
        const existing = prev[relativePath]
        if (existing && sameListing(existing, entries)) continue
        next[relativePath] = entries
        changed = true
      }
      for (const relativePath of Object.keys(prev)) {
        if (!isStaleOrOrphaned(relativePath)) continue
        delete next[relativePath]
        changed = true
      }
      return changed ? next : prev
    })

    setExpandedDirs((prev) => {
      const removed = [...prev].filter(isStaleOrOrphaned)
      if (removed.length === 0) return prev
      const next = new Set(prev)
      for (const relativePath of removed) next.delete(relativePath)
      return next
    })

    // A directory that reads cleanly again clears its stale error banner.
    setDirectoryErrors((prev) => {
      const resolved = Object.keys(prev).filter(p => refreshed.has(p))
      if (resolved.length === 0) return prev
      const next = { ...prev }
      for (const relativePath of resolved) delete next[relativePath]
      return next
    })
  }, [projectDir])

  // Fetch root directory on mount or when projectDir changes
  useEffect(() => {
    directoryVersionRef.current += 1
    setExpandedDirs(new Set())
    setChildrenCache({})
    setLoadingDirs(new Set())
    setDirectoryErrors({})
    void fetchDirectory('')
    return () => {
      directoryVersionRef.current += 1
    }
  }, [projectDir, fetchDirectory])

  // Nothing notifies us when files appear on disk (terminals, AI tools, git
  // checkouts all write behind our back), so poll on the same cadence as the
  // git panel.
  useEffect(() => {
    if (!projectDir) return
    const run = (): void => { void refreshVisibleDirectories() }

    const intervalId = window.setInterval(run, FILE_BROWSER_REFRESH_MS)
    window.addEventListener('focus', run)
    window.addEventListener('file-saved', run)

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', run)
      window.removeEventListener('file-saved', run)
    }
  }, [projectDir, refreshVisibleDirectories])

  const handleToggleDir = useCallback(
    (relativePath: string) => {
      setExpandedDirs((prev) => {
        const next = new Set(prev)
        if (next.has(relativePath)) {
          next.delete(relativePath)
        } else {
          next.add(relativePath)
          if (!childrenCache[relativePath]) {
            fetchDirectory(relativePath)
          }
        }
        return next
      })
    },
    [childrenCache, fetchDirectory]
  )

  const rootEntries = childrenCache['']
  const rootError = directoryErrors['']

  return (
    <div className="overflow-y-auto text-base">
      {!rootEntries && loadingDirs.has('') && (
        <div className="text-text-muted px-2 py-0.5 italic">Loading...</div>
      )}
      {rootError && (
        <div className="m-2 rounded-md border border-border bg-surface-2 p-3">
          <div className="text-danger font-medium">Project directory is unavailable</div>
          <div className="mt-1 break-all text-xs text-text-muted" title={rootError}>{projectDir}</div>
          <div className="mt-2 text-xs text-text-muted">
            Choose its new location in Project Settings, or restore the directory and retry.
          </div>
          <button
            type="button"
            className="mt-2 h-(--ctl-h-sm) rounded-md border border-border bg-field px-2 text-sm text-text-muted hover:text-text cursor-pointer"
            onClick={() => { void fetchDirectory('') }}
          >
            Retry
          </button>
        </div>
      )}
      {rootEntries &&
        rootEntries.map((entry) => (
          <TreeNode
            key={entry.relativePath}
            entry={entry}
            level={0}
            projectDir={projectDir}
            expandedDirs={expandedDirs}
            childrenCache={childrenCache}
            loadingDirs={loadingDirs}
            directoryErrors={directoryErrors}
            gitMap={gitMap}
            onToggleDir={handleToggleDir}
            onFileClick={onFileClick}
          />
        ))}
    </div>
  )
}

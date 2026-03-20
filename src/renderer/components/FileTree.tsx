import React, { useState, useEffect, useCallback } from 'react'
import type { DirectoryEntry, GitStatusResult, GitFileStatus } from '../../shared/types'
import './FileTree.css'

interface Props {
  projectDir: string
  gitStatus: GitStatusResult | null
  onFileClick: (filePath: string) => void
}

type StatusColor = '#f44747' | '#e5c07b' | '#4ec9b0' | undefined

function statusToColor(status: GitFileStatus): StatusColor {
  switch (status) {
    case 'D':
      return '#f44747'
    case 'M':
      return '#e5c07b'
    case 'A':
    case '?':
      return '#4ec9b0'
    default:
      return undefined
  }
}

function colorSeverity(color: StatusColor): number {
  if (color === '#f44747') return 3
  if (color === '#e5c07b') return 2
  if (color === '#4ec9b0') return 1
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

interface TreeNodeProps {
  entry: DirectoryEntry
  level: number
  projectDir: string
  expandedDirs: Set<string>
  childrenCache: Record<string, DirectoryEntry[]>
  loadingDirs: Set<string>
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
  gitMap,
  onToggleDir,
  onFileClick,
}: TreeNodeProps) {
  const isDirectory = entry.type === 'directory'
  const isExpanded = expandedDirs.has(entry.relativePath)
  const children = childrenCache[entry.relativePath]
  const isLoading = loadingDirs.has(entry.relativePath)

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
        className="filetree-node"
        style={{ paddingLeft: 8 + level * 16, color: color || 'var(--text-primary)' }}
        onClick={handleClick}
      >
        <span className="filetree-caret">
          {isDirectory ? (isExpanded ? '▾' : '▸') : ''}
        </span>
        <span className="filetree-name">{entry.name}</span>
      </div>
      {isDirectory && isExpanded && (
        <>
          {isLoading && (
            <div className="filetree-loading" style={{ paddingLeft: 8 + (level + 1) * 16 }}>
              Loading...
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

  const gitMap = React.useMemo(() => buildGitMap(gitStatus), [gitStatus])

  const fetchDirectory = useCallback(
    async (relativePath: string) => {
      setLoadingDirs((prev) => new Set(prev).add(relativePath))
      try {
        const entries = await window.api.fbReadDirectory(projectDir, relativePath)
        setChildrenCache((prev) => ({ ...prev, [relativePath]: entries }))
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev)
          next.delete(relativePath)
          return next
        })
      }
    },
    [projectDir]
  )

  // Fetch root directory on mount or when projectDir changes
  useEffect(() => {
    setExpandedDirs(new Set())
    setChildrenCache({})
    setLoadingDirs(new Set())
    fetchDirectory('')
  }, [projectDir, fetchDirectory])

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

  return (
    <div className="filetree">
      {!rootEntries && loadingDirs.has('') && (
        <div className="filetree-loading">Loading...</div>
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
            gitMap={gitMap}
            onToggleDir={handleToggleDir}
            onFileClick={onFileClick}
          />
        ))}
    </div>
  )
}

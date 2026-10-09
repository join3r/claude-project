import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { DirectoryEntry, GitStatusResult, GitFileStatus } from '../../shared/types'
import { ChevronRight, Folder, FileText, BookText } from 'lucide-react'
import { FILE_BROWSER_REFRESH_MS } from '../hooks/fileBrowserRefresh'
import { posixRelativeJoin } from '../../shared/workspace-path'
import { isNotebookFile } from '../../shared/notebook'
import { revealInFolderLabel } from '../utils/revealLabel'

interface Props {
  projectDir: string
  /** Routes the file calls to a DevTool server's project. */
  projectId?: string
  gitStatus: GitStatusResult | null
  onFileClick: (filePath: string) => void
  filterQuery?: string
  onRevealInTerminal?: (relativeDir: string) => void
  ideEditors?: Array<{ id: string; name: string }>
  onOpenInIde?: (editorId: string) => Promise<string | null>
  /** "Link to agent": insert an `@path` link into the task's agent tab. */
  onLinkToAgent?: (relativePath: string, isDirectory: boolean) => void
}

type StatusColor = 'var(--color-danger)' | 'var(--color-warn)' | 'var(--color-success)' | undefined

type Draft =
  | { mode: 'create'; parent: string; kind: 'file' | 'directory'; seed: string }
  | { mode: 'rename'; relativePath: string; name: string; kind: 'file' | 'directory' }

/** Strip Electron's IPC wrapper and turn syscall errors into a short UI line. */
function fileActionErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
  if (/\bEEXIST\b/i.test(message) || /file already exists/i.test(message)) {
    return 'A file or folder with that name already exists'
  }
  return message
}

type ContextMenuState = {
  x: number
  y: number
  relativePath: string
  isDirectory: boolean
}

const menuItemCls = 'block w-full rounded-md px-2.5 py-1 bg-transparent border-0 text-text text-sm text-left cursor-pointer hover:bg-sel'
const menuCls = 'bg-surface border-[0.5px] border-border rounded-lg p-1 shadow-pop min-w-[160px]'

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

function entryIsVisible(
  entry: DirectoryEntry,
  filterQuery: string,
  childrenCache: Record<string, DirectoryEntry[]>
): boolean {
  const q = filterQuery.trim().toLowerCase()
  if (!q) return true
  if (entry.name.toLowerCase().includes(q)) return true
  if (entry.type !== 'directory') return false
  const children = childrenCache[entry.relativePath]
  if (!children) return false
  return children.some((child) => entryIsVisible(child, filterQuery, childrenCache))
}

interface TreeNodeProps {
  entry: DirectoryEntry
  level: number
  expandedDirs: Set<string>
  childrenCache: Record<string, DirectoryEntry[]>
  loadingDirs: Set<string>
  directoryErrors: Record<string, string>
  gitMap: Map<string, GitFileStatus>
  selectedPath: string | null
  filterQuery: string
  draft: Draft | null
  draftNonce: number
  onToggleDir: (relativePath: string) => void
  onFileClick: (filePath: string) => void
  onSelect: (relativePath: string) => void
  onContextMenu: (event: React.MouseEvent, relativePath: string, isDirectory: boolean) => void
  onSubmitDraft: (name: string) => void
  onCancelDraft: () => void
}

function TreeNode({
  entry,
  level,
  expandedDirs,
  childrenCache,
  loadingDirs,
  directoryErrors,
  gitMap,
  selectedPath,
  filterQuery,
  draft,
  draftNonce,
  onToggleDir,
  onFileClick,
  onSelect,
  onContextMenu,
  onSubmitDraft,
  onCancelDraft
}: TreeNodeProps) {
  const isDirectory = entry.type === 'directory'
  const isExpanded = expandedDirs.has(entry.relativePath)
  const children = childrenCache[entry.relativePath]
  const isLoading = loadingDirs.has(entry.relativePath)
  const loadError = directoryErrors[entry.relativePath]
  const renaming = draft?.mode === 'rename' && draft.relativePath === entry.relativePath
  const creatingHere = draft?.mode === 'create' && draft.parent === entry.relativePath && isDirectory && isExpanded

  let color: string | undefined
  if (isDirectory) {
    color = getDirectoryColor(entry.relativePath, gitMap)
  } else {
    const status = gitMap.get(entry.relativePath)
    color = status ? statusToColor(status) : undefined
  }

  const handleClick = useCallback(() => {
    onSelect(entry.relativePath)
    if (isDirectory) {
      onToggleDir(entry.relativePath)
      return
    }
    onFileClick(entry.relativePath)
  }, [isDirectory, entry.relativePath, onToggleDir, onFileClick, onSelect])

  const visibleChildren = (children ?? []).filter((child) =>
    entryIsVisible(child, filterQuery, childrenCache)
  )

  return (
    <>
      <div
        className={`flex items-center px-2 py-0.5 cursor-pointer whitespace-nowrap select-none hover:bg-surface-3 transition-colors duration-(--motion-fast) ${selectedPath === entry.relativePath ? 'bg-sel' : ''}`}
        style={{ paddingLeft: 8 + level * 16, color: color || 'var(--color-text)' }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry.relativePath, isDirectory)}
      >
        <span className="w-4 flex items-center justify-center shrink-0 text-text-muted">
          {isDirectory ? <ChevronRight size={12} className={`transition-transform duration-(--motion-fast) ${isExpanded ? 'rotate-90' : ''}`} /> : null}
        </span>
        {isDirectory
          ? <Folder size={12} className="mr-1.5 text-text-muted shrink-0" />
          : isNotebookFile(entry.name)
            ? <BookText size={12} className="mr-1.5 text-text-muted shrink-0" />
            : <FileText size={12} className="mr-1.5 text-text-muted shrink-0" />
        }
        {renaming ? (
          <DraftInput
            key={draftNonce}
            initialValue={draft.name}
            placeholder={isDirectory ? 'folder name' : 'file name'}
            onSubmit={onSubmitDraft}
            onCancel={onCancelDraft}
          />
        ) : (
          <span className="overflow-hidden text-ellipsis" style={{ color: color }}>{entry.name}</span>
        )}
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
          {creatingHere && (
            <DraftRow
              level={level + 1}
              kind={draft.kind}
              initialValue={draft.seed}
              draftNonce={draftNonce}
              onSubmit={onSubmitDraft}
              onCancel={onCancelDraft}
            />
          )}
          {visibleChildren.map((child) => (
            <TreeNode
              key={child.relativePath}
              entry={child}
              level={level + 1}
              expandedDirs={expandedDirs}
              childrenCache={childrenCache}
              loadingDirs={loadingDirs}
              directoryErrors={directoryErrors}
              gitMap={gitMap}
              selectedPath={selectedPath}
              filterQuery={filterQuery}
              draft={draft}
              draftNonce={draftNonce}
              onToggleDir={onToggleDir}
              onFileClick={onFileClick}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onSubmitDraft={onSubmitDraft}
              onCancelDraft={onCancelDraft}
            />
          ))}
        </>
      )}
    </>
  )
}

function DraftRow({
  level,
  kind,
  initialValue,
  draftNonce,
  onSubmit,
  onCancel
}: {
  level: number
  kind: 'file' | 'directory'
  initialValue: string
  draftNonce: number
  onSubmit: (name: string) => void
  onCancel: () => void
}): React.ReactElement {
  return (
    <div
      className="flex items-center px-2 py-0.5 whitespace-nowrap"
      style={{ paddingLeft: 8 + level * 16 }}
    >
      <span className="w-4 shrink-0" />
      {kind === 'directory'
        ? <Folder size={12} className="mr-1.5 text-text-muted shrink-0" />
        : <FileText size={12} className="mr-1.5 text-text-muted shrink-0" />
      }
      <DraftInput
        key={draftNonce}
        initialValue={initialValue}
        placeholder={kind === 'directory' ? 'folder name' : 'file name'}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </div>
  )
}

function DraftInput({
  initialValue,
  placeholder,
  onSubmit,
  onCancel
}: {
  initialValue: string
  placeholder: string
  onSubmit: (name: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [value, setValue] = useState(initialValue)
  const finishedRef = useRef(false)

  const finish = (next: string, cancel: boolean): void => {
    if (finishedRef.current) return
    finishedRef.current = true
    if (cancel || !next.trim()) onCancel()
    else onSubmit(next)
  }

  return (
    <input
      autoFocus
      className="min-w-0 flex-1 h-(--ctl-h-sm) px-1 rounded-sm bg-field border border-border-focus text-sm text-text outline-none"
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(value, false)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(value, true)
        }
      }}
      onBlur={() => finish(value, !value.trim())}
    />
  )
}

export type FileTreeHandle = {
  /** Create in the selected folder, the parent of a selected file, or the project root. */
  startCreate: (kind: 'file' | 'directory') => void
  expandAll: () => Promise<void>
  collapseAll: () => void
}

const FileTree = React.forwardRef<FileTreeHandle, Props>(function FileTree({
  projectDir,
  projectId,
  gitStatus,
  onFileClick,
  filterQuery = '',
  onRevealInTerminal,
  ideEditors = [],
  onOpenInIde,
  onLinkToAgent
}, ref) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [childrenCache, setChildrenCache] = useState<Record<string, DirectoryEntry[]>>({})
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [directoryErrors, setDirectoryErrors] = useState<Record<string, string>>({})
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftNonce, setDraftNonce] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const directoryVersionRef = React.useRef(0)
  const expandedDirsRef = React.useRef(expandedDirs)
  expandedDirsRef.current = expandedDirs
  const childrenCacheRef = React.useRef(childrenCache)
  childrenCacheRef.current = childrenCache
  const treeRef = useRef<HTMLDivElement>(null)

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
        const entries = await window.api.fbReadDirectory(projectDir, relativePath, projectId)
        if (directoryVersion !== directoryVersionRef.current) return undefined
        setChildrenCache((prev) => ({ ...prev, [relativePath]: entries }))
        childrenCacheRef.current = { ...childrenCacheRef.current, [relativePath]: entries }
        return entries
      } catch (error) {
        if (directoryVersion !== directoryVersionRef.current) return undefined
        const message = error instanceof Error ? error.message : String(error)
        setDirectoryErrors((prev) => ({ ...prev, [relativePath]: message }))
        return undefined
      } finally {
        // Intentional: a stale load (directory version changed) resolves to undefined even
        // when the try block returned entries, matching the other stale-load early returns.
        // eslint-disable-next-line no-unsafe-finally
        if (directoryVersion !== directoryVersionRef.current) return
        setLoadingDirs((prev) => {
          const next = new Set(prev)
          next.delete(relativePath)
          return next
        })
      }
    },
    [projectDir, projectId]
  )
  const fetchDirectoryRef = React.useRef(fetchDirectory)
  fetchDirectoryRef.current = fetchDirectory

  const refreshVisibleDirectories = useCallback(async () => {
    if (!projectDir) return
    const directoryVersion = directoryVersionRef.current
    const paths = ['', ...expandedDirsRef.current]

    const results = await Promise.all(
      paths.map(async (relativePath) => {
        try {
          return { relativePath, entries: await window.api.fbReadDirectory(projectDir, relativePath, projectId) }
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

    const liveDirs = new Set<string>()
    for (const entries of refreshed.values()) {
      for (const entry of entries) {
        if (entry.type === 'directory') liveDirs.add(entry.relativePath)
      }
    }
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

    setDirectoryErrors((prev) => {
      const resolved = Object.keys(prev).filter(p => refreshed.has(p))
      if (resolved.length === 0) return prev
      const next = { ...prev }
      for (const relativePath of resolved) delete next[relativePath]
      return next
    })
  }, [projectDir, projectId])

  useEffect(() => {
    directoryVersionRef.current += 1
    setExpandedDirs(new Set())
    setChildrenCache({})
    setLoadingDirs(new Set())
    setDirectoryErrors({})
    setSelectedPath(null)
    setDraft(null)
    setActionError(null)
    void fetchDirectoryRef.current('')
    return () => {
      directoryVersionRef.current += 1
    }
  }, [projectDir, projectId])

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
  }, [projectDir, projectId, refreshVisibleDirectories])

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

  const notifyTreeChanged = useCallback(() => {
    window.dispatchEvent(new Event('file-saved'))
    void refreshVisibleDirectories()
  }, [refreshVisibleDirectories])

  const handleContextMenu = useCallback((event: React.MouseEvent, relativePath: string, isDirectory: boolean) => {
    event.preventDefault()
    event.stopPropagation()
    setSelectedPath(relativePath)
    setMenu({ x: event.clientX, y: event.clientY, relativePath, isDirectory })
  }, [])

  const startCreate = useCallback((parent: string, kind: 'file' | 'directory') => {
    setMenu(null)
    if (parent) {
      setExpandedDirs((prev) => {
        const next = new Set(prev)
        next.add(parent)
        return next
      })
      if (!childrenCacheRef.current[parent]) void fetchDirectory(parent)
    }
    setActionError(null)
    setDraft({ mode: 'create', parent, kind, seed: '' })
  }, [fetchDirectory])

  const collapseAll = useCallback(() => {
    setExpandedDirs(new Set())
  }, [])

  const expandAll = useCallback(async () => {
    const expanded = new Set<string>()
    const queue = ['']
    let opened = 0
    const version = directoryVersionRef.current
    const maxOpen = 200
    while (queue.length > 0 && opened < maxOpen) {
      const dir = queue.shift() as string
      let entries = childrenCacheRef.current[dir]
      if (!entries) {
        const fetched = await fetchDirectoryRef.current(dir)
        if (version !== directoryVersionRef.current) return
        if (!fetched) continue
        entries = fetched
      }
      for (const entry of entries) {
        if (entry.type !== 'directory') continue
        expanded.add(entry.relativePath)
        queue.push(entry.relativePath)
        opened += 1
      }
    }
    setExpandedDirs(expanded)
  }, [])

  React.useImperativeHandle(ref, () => ({
    startCreate: (kind: 'file' | 'directory') => {
      const selected = selectedPath
      let parent = ''
      if (selected) {
        const listing = childrenCacheRef.current[parentDirOf(selected)] ?? childrenCacheRef.current[''] ?? []
        const entry = listing.find((item) => item.relativePath === selected)
        parent = entry?.type === 'directory' ? selected : parentDirOf(selected)
      }
      startCreate(parent, kind)
    },
    expandAll,
    collapseAll
  }), [selectedPath, startCreate, expandAll, collapseAll])

  const startRename = useCallback((relativePath: string, isDirectory: boolean, name: string) => {
    setMenu(null)
    if (!relativePath) return
    setActionError(null)
    setDraft({ mode: 'rename', relativePath, name, kind: isDirectory ? 'directory' : 'file' })
  }, [])

  const handleDelete = useCallback(async (relativePath: string, isDirectory: boolean) => {
    setMenu(null)
    if (!relativePath) return
    const name = relativePath.split('/').pop() ?? relativePath
    const ok = window.confirm(
      isDirectory
        ? `Delete folder "${name}" and everything inside it?`
        : `Delete "${name}"?`
    )
    if (!ok) return
    try {
      await window.api.fbDelete(projectDir, relativePath, projectId)
      setActionError(null)
      notifyTreeChanged()
    } catch (error) {
      setActionError(fileActionErrorMessage(error))
    }
  }, [projectDir, projectId, notifyTreeChanged])

  const handleSubmitDraft = useCallback(async (name: string) => {
    const current = draft
    if (!current) return
    const trimmed = name.trim()
    if (!trimmed) {
      setDraft(null)
      setActionError(null)
      return
    }
    try {
      if (current.mode === 'create') {
        if (current.kind === 'directory') {
          await window.api.fbCreateDirectory(projectDir, current.parent, trimmed, projectId)
        } else {
          await window.api.fbCreateFile(projectDir, current.parent, trimmed, projectId)
        }
        const createdPath = posixRelativeJoin(current.parent, trimmed)
        setSelectedPath(createdPath)
      } else {
        await window.api.fbRename(projectDir, current.relativePath, trimmed, projectId)
        const parent = parentDirOf(current.relativePath)
        setSelectedPath(posixRelativeJoin(parent, trimmed))
      }
      setDraft(null)
      setActionError(null)
      notifyTreeChanged()
    } catch (error) {
      setActionError(fileActionErrorMessage(error))
      setDraftNonce((n) => n + 1)
      if (current.mode === 'create') {
        setDraft({ ...current, seed: trimmed })
      } else {
        setDraft({ ...current, name: trimmed })
      }
    }
  }, [draft, projectDir, projectId, notifyTreeChanged])

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (draft) return
    const path = selectedPath
    if (path === null) return
    if (event.key === 'F2') {
      event.preventDefault()
      if (!path) return
      const name = path.split('/').pop() ?? path
      const listing = childrenCache[parentDirOf(path)] ?? []
      const entry = listing.find((item) => item.relativePath === path)
      startRename(path, entry?.type === 'directory', name)
    } else if (event.key === 'Delete' || (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))) {
      if (!path) return
      event.preventDefault()
      const listing = childrenCache[parentDirOf(path)] ?? []
      const entry = listing.find((item) => item.relativePath === path)
      void handleDelete(path, entry?.type === 'directory')
    }
  }, [draft, selectedPath, childrenCache, startRename, handleDelete])

  const rootEntries = childrenCache['']
  const rootError = directoryErrors['']
  const visibleRoot = (rootEntries ?? []).filter((entry) =>
    entryIsVisible(entry, filterQuery, childrenCache)
  )
  const creatingAtRoot = draft?.mode === 'create' && draft.parent === ''

  const menuTargetIsRoot = menu?.relativePath === ''
  const createParent = menu
    ? (menu.isDirectory ? menu.relativePath : parentDirOf(menu.relativePath))
    : ''
  const revealDir = menu
    ? (menu.isDirectory ? menu.relativePath : parentDirOf(menu.relativePath))
    : ''

  return (
    <div
      ref={treeRef}
      className="overflow-y-auto text-base h-full outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget) handleContextMenu(e, '', true)
      }}
    >
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
      {actionError && (
        <div role="alert" className="text-danger px-2 py-1 text-sm">
          {actionError}
        </div>
      )}
      {creatingAtRoot && (
        <DraftRow
          level={0}
          kind={draft.kind}
          initialValue={draft.seed}
          draftNonce={draftNonce}
          onSubmit={(name) => { void handleSubmitDraft(name) }}
          onCancel={() => {
            setDraft(null)
            setActionError(null)
          }}
        />
      )}
      {visibleRoot.map((entry) => (
        <TreeNode
          key={entry.relativePath}
          entry={entry}
          level={0}
          expandedDirs={expandedDirs}
          childrenCache={childrenCache}
          loadingDirs={loadingDirs}
          directoryErrors={directoryErrors}
          gitMap={gitMap}
          selectedPath={selectedPath}
          filterQuery={filterQuery}
          draft={draft}
          draftNonce={draftNonce}
          onToggleDir={handleToggleDir}
          onFileClick={onFileClick}
          onSelect={setSelectedPath}
          onContextMenu={handleContextMenu}
          onSubmitDraft={(name) => { void handleSubmitDraft(name) }}
          onCancelDraft={() => {
            setDraft(null)
            setActionError(null)
          }}
        />
      ))}
      {menu && (
        <>
          <div
            className="fixed inset-0 z-(--z-menu)"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}
          />
          <div
            className={`fixed z-(--z-menu) ${menuCls}`}
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button className={menuItemCls} onClick={() => startCreate(createParent, 'file')}>New file</button>
            <button className={menuItemCls} onClick={() => startCreate(createParent, 'directory')}>New folder</button>
            {!menuTargetIsRoot && onLinkToAgent && (
              <button
                className={menuItemCls}
                onClick={() => {
                  setMenu(null)
                  onLinkToAgent(menu.relativePath, menu.isDirectory)
                }}
              >
                Link to agent
              </button>
            )}
            {!menuTargetIsRoot && (
              <>
                <button
                  className={menuItemCls}
                  onClick={() => startRename(
                    menu.relativePath,
                    menu.isDirectory,
                    menu.relativePath.split('/').pop() ?? menu.relativePath
                  )}
                >
                  Rename
                </button>
                <button
                  className={`${menuItemCls} text-danger`}
                  onClick={() => { void handleDelete(menu.relativePath, menu.isDirectory) }}
                >
                  Delete
                </button>
              </>
            )}
            <button
              className={menuItemCls}
              onClick={() => {
                setMenu(null)
                window.api.revealInFolder(projectDir, menu.relativePath || undefined, projectId)
                  .then(() => setActionError(null))
                  .catch((error: unknown) => setActionError(fileActionErrorMessage(error)))
              }}
            >
              {revealInFolderLabel()}
            </button>
            {onRevealInTerminal && (
              <button
                className={menuItemCls}
                onClick={() => {
                  setMenu(null)
                  onRevealInTerminal(revealDir)
                }}
              >
                Reveal in Git Bash
              </button>
            )}
            {onOpenInIde && ideEditors.map((editor) => (
              <button
                key={editor.id}
                className={menuItemCls}
                onClick={() => {
                  setMenu(null)
                  void onOpenInIde(editor.id).then((message) => {
                    if (message) setActionError(message)
                    else setActionError(null)
                  })
                }}
              >
                Open in {editor.name || 'editor'}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
})

export default FileTree

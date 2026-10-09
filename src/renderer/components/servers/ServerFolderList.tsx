import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder, GitBranch } from 'lucide-react'
import type { HostDirListing } from '../../../shared/host-fs'
import { Field, HelperText, Switch } from '../ui'

export function serverErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
}

interface Props {
  serverId: string
  /** The folder to start in; '' is the server's home folder. */
  initialDir?: string
  /** Folders to mark "added" (already projects). */
  existing?: ReadonlySet<string>
  /** The folder shown, each time it changes. */
  onListing: (listing: HostDirListing) => void
}

/**
 * A DevTool server's folders, one level at a time (`server-list-dirs`): the
 * path field, Up, the folders with their git badge, and "Show hidden folders".
 * The Add server project dialog and Project settings' Browse… both pick with it.
 */
export default function ServerFolderList({ serverId, initialDir = '', existing, onListing }: Props): React.ReactElement {
  const [listing, setListing] = useState<HostDirListing | null>(null)
  const [pathInput, setPathInput] = useState(initialDir)
  const [showHidden, setShowHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  /** The folder shown; the starting folder until the first listing. */
  const currentRef = useRef(initialDir)
  const onListingRef = useRef(onListing)
  onListingRef.current = onListing

  const open = useCallback((dir: string) => {
    const id = ++request.current
    setError(null)
    window.api.serverListDirs(serverId, dir, { showHidden })
      .then((next) => {
        if (id !== request.current) return
        currentRef.current = next.path
        setListing(next)
        setPathInput(next.path)
        onListingRef.current(next)
      })
      .catch((err: unknown) => { if (id === request.current) setError(serverErrorText(err)) })
  }, [serverId, showHidden])

  // The starting folder first; the hidden toggle lists the same folder again.
  useEffect(() => { open(currentRef.current) }, [open])

  return (
    <>
      <div className="flex gap-2">
        <button
          type="button"
          className="h-(--ctl-h) px-2 rounded-md bg-field text-text-muted hover:text-text border border-border cursor-pointer disabled:opacity-50"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && open(listing.parent)}
          title="Up"
        ><ArrowUp size={14} /></button>
        <Field
          className="flex-1 font-mono text-sm"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') open(pathInput) }}
          placeholder="~"
          aria-label="Folder on the server"
        />
      </div>
      {error && <HelperText>{error}</HelperText>}
      <div className="flex flex-col h-[240px] overflow-y-auto rounded-md border border-border bg-field" data-testid="server-folder-list">
        {listing && listing.entries.length === 0 && (
          <div className="px-2.5 py-2 text-sm text-text-subtle">No folders here.</div>
        )}
        {listing?.entries.map(entry => (
          <button
            key={entry.path}
            type="button"
            className="flex items-center gap-2 px-2.5 py-1 text-left text-base text-text bg-transparent border-0 border-b border-hair last:border-b-0 cursor-pointer hover:bg-surface-3"
            onClick={() => open(entry.path)}
            title={entry.path}
          >
            {entry.git ? <GitBranch size={12} className="shrink-0 text-text-subtle" /> : <Folder size={12} className="shrink-0 text-text-subtle" />}
            <span className="truncate">{entry.name}</span>
            {existing?.has(entry.path) && <span className="ml-auto text-2xs text-text-subtle shrink-0">added</span>}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-text-muted self-start cursor-pointer">
        <Switch checked={showHidden} onChange={setShowHidden} />
        Show hidden folders
      </label>
    </>
  )
}

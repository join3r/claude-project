import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { ArrowUp, Folder, GitBranch } from 'lucide-react'
import type { HostDirListing } from '../../../shared/host-fs'
import type { ServerStatus } from '../../../shared/servers'
import { Field, HelperText, LinkBtn, Modal, PrimaryButton, SegCtl, Select, SetBlock, Switch } from '../ui'
import ServerRepoDiscovery from './ServerRepoDiscovery'

type Mode = 'browse' | 'clone' | 'found'

const MODES: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: 'browse', label: 'Pick a folder' },
  { value: 'clone', label: 'Clone repository' },
  { value: 'found', label: 'Found on this server' }
]

interface Props {
  /** The paired servers; at least one. */
  servers: ServerStatus[]
  /** Folders that already are projects, per server. */
  existingDirectories: (serverId: string) => ReadonlySet<string>
  onAdd: (serverId: string, projects: Array<{ name: string; directory: string }>) => void
  onClose: () => void
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')
}

function baseName(dir: string): string {
  return dir.split('/').filter(Boolean).pop() ?? dir
}

/**
 * Sidebar "+" › Server project…: a project on a DevTool server, from a folder
 * picked on the server, a repository cloned there, or the repositories found
 * under its home.
 */
export default function AddServerProject({ servers, existingDirectories, onAdd, onClose }: Props): React.ReactElement {
  const firstOnline = servers.find(s => s.state === 'online') ?? servers[0]
  const [serverId, setServerId] = useState(firstOnline?.id ?? '')
  const [mode, setMode] = useState<Mode>('browse')
  const server = servers.find(s => s.id === serverId)
  const online = server?.state === 'online'
  const existing = useMemo(() => existingDirectories(serverId), [existingDirectories, serverId])

  return (
    <Modal title="Add Server Project" onClose={onClose} width="w-[560px]">
      <div className="flex items-center gap-2">
        {servers.length > 1 ? (
          <Select className="flex-1" value={serverId} onChange={(e) => setServerId(e.target.value)} aria-label="Server">
            {servers.map(s => (
              <option key={s.id} value={s.id}>{s.name}{s.state === 'online' ? '' : ` (${s.state})`}</option>
            ))}
          </Select>
        ) : (
          <span className="text-base font-semibold text-text flex-1 truncate">{server?.name}</span>
        )}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${online ? 'bg-success' : 'bg-status-exited'}`} />
        <span className="text-sm text-text-muted shrink-0">{online ? 'online' : server?.state ?? 'offline'}</span>
      </div>
      <SegCtl options={MODES} value={mode} onChange={setMode} disabled={!online} />
      {!online ? (
        <HelperText>{server?.name ?? 'The server'} is offline. Its projects can be added once it is back.</HelperText>
      ) : mode === 'browse' ? (
        <FolderBrowser key={serverId} serverId={serverId} existing={existing} onAdd={(name, directory) => onAdd(serverId, [{ name, directory }])} onCancel={onClose} />
      ) : mode === 'clone' ? (
        <CloneForm key={serverId} serverId={serverId} onAdd={(name, directory) => onAdd(serverId, [{ name, directory }])} onCancel={onClose} />
      ) : (
        <ServerRepoDiscovery
          key={serverId}
          serverId={serverId}
          existingDirectories={existing}
          onAdd={(repos) => onAdd(serverId, repos)}
          secondary={<LinkBtn onClick={onClose}>Cancel</LinkBtn>}
        />
      )}
    </Modal>
  )
}

function FolderBrowser({ serverId, existing, onAdd, onCancel }: {
  serverId: string
  existing: ReadonlySet<string>
  onAdd: (name: string, directory: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [listing, setListing] = useState<HostDirListing | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const nameTouched = useRef(false)
  const request = useRef(0)
  /** The folder shown; '' (the home folder) until the first listing. */
  const currentRef = useRef('')

  const open = useCallback((dir: string) => {
    const id = ++request.current
    setError(null)
    window.api.serverListDirs(serverId, dir, { showHidden })
      .then((next) => {
        if (id !== request.current) return
        currentRef.current = next.path
        setListing(next)
        setPathInput(next.path)
        if (!nameTouched.current) setName(baseName(next.path))
      })
      .catch((err: unknown) => { if (id === request.current) setError(errorText(err)) })
  }, [serverId, showHidden])

  // The home folder first; the hidden toggle lists the same folder again.
  useEffect(() => { open(currentRef.current) }, [open])

  const dir = listing?.path ?? ''
  const already = existing.has(dir)

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
            {existing.has(entry.path) && <span className="ml-auto text-2xs text-text-subtle shrink-0">added</span>}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-text-muted self-start cursor-pointer">
        <Switch checked={showHidden} onChange={setShowHidden} />
        Show hidden folders
      </label>
      <SetBlock label="Project name">
        <Field value={name} onChange={(e) => { nameTouched.current = true; setName(e.target.value) }} placeholder="My Project" />
      </SetBlock>
      <div className="flex items-center justify-end gap-3 pt-1">
        {already && <span className="text-sm text-text-subtle mr-auto">Already a project</span>}
        <LinkBtn onClick={onCancel}>Cancel</LinkBtn>
        <PrimaryButton onClick={() => onAdd(name.trim() || baseName(dir), dir)} disabled={!dir || already}>Add this folder</PrimaryButton>
      </div>
    </>
  )
}

function CloneForm({ serverId, onAdd, onCancel }: {
  serverId: string
  onAdd: (name: string, directory: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [url, setUrl] = useState('')
  const [parentDir, setParentDir] = useState('~/projects')
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const opRef = useRef<string | null>(null)

  useEffect(() => window.api.onServerCloneProgress((opId, line) => {
    if (opId !== opRef.current) return
    // git redraws its progress in place: a line with the same label replaces the last one.
    setLines(prev => {
      const label = line.split(':')[0]
      const last = prev[prev.length - 1]
      const next = last && last.split(':')[0] === label ? [...prev.slice(0, -1), line] : [...prev, line]
      return next.slice(-8)
    })
  }), [])

  const clone = async (): Promise<void> => {
    const opId = uuid()
    opRef.current = opId
    setBusy(true)
    setError(null)
    setLines([])
    try {
      const result = await window.api.serverCloneRepo(serverId, { url: url.trim(), parentDir: parentDir.trim() || undefined, opId })
      onAdd(result.name, result.path)
    } catch (err) {
      setError(errorText(err))
    } finally {
      opRef.current = null
      setBusy(false)
    }
  }

  return (
    <>
      <SetBlock label="Repository URL">
        <Field value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@github.com:you/repo.git" autoFocus disabled={busy} />
      </SetBlock>
      <SetBlock label="Clone into" sub="A folder on the server; made if missing.">
        <Field className="font-mono text-sm" value={parentDir} onChange={(e) => setParentDir(e.target.value)} disabled={busy} />
      </SetBlock>
      {lines.length > 0 && (
        <pre className="m-0 px-2.5 py-2 rounded-md border border-border bg-field text-xs text-text-muted font-mono whitespace-pre-wrap max-h-[140px] overflow-y-auto" data-testid="server-clone-progress">
          {lines.join('\n')}
        </pre>
      )}
      {error && <HelperText>{error}</HelperText>}
      <HelperText>The server clones it with its own git and credentials; nothing is copied from this computer.</HelperText>
      <div className="flex items-center justify-end gap-3 pt-1">
        <LinkBtn onClick={onCancel}>Cancel</LinkBtn>
        <PrimaryButton onClick={() => { void clone() }} disabled={busy || !url.trim()}>{busy ? 'Cloning…' : 'Clone and add'}</PrimaryButton>
      </div>
    </>
  )
}

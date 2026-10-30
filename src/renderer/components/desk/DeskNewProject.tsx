import React, { useEffect, useMemo, useState } from 'react'
import ServerFolderList from '../servers/ServerFolderList'
import ThemedSelect from '../ThemedSelect'
import { Modal, SetBlock, Field, HelperText, LinkBtn, PrimaryButton, SegCtl } from '../ui'
import { ipcErrorMessage } from '../../utils/ipcErrorMessage'
import { folderName, MAC_HOST_KEY, newProjectHostUsable, type HostEntry } from '../../hosts'

/** The pick in the Host field that leaves for Settings › Hosts. */
const ADD_HOST = '__add-host__'

const KIND_WORD: Record<HostEntry['kind'], string> = {
  mac: '',
  server: 'server',
  ssh: 'SSH',
  shell: 'shell'
}

interface Props {
  /** Every host (`listHosts`); servers that aren't online are offered greyed in words only. */
  hosts: readonly HostEntry[]
  /** Called with the host, the name (may be empty: the folder's name) and the folder. */
  onCreate: (host: HostEntry, name: string, directory: string) => void
  /** + Add a host…: Settings › Hosts. */
  onAddHost: () => void
  onCancel: () => void
}

/**
 * The desk's New project (change 6 of the redesign): a host from Settings ›
 * Hosts, then a folder on it, and nothing else. On this Mac or a server the
 * folder is either new (made under the host's projects folder, `git init`ed)
 * or one that's there already; on an SSH box it's a path on the box; a custom
 * shell has no folder, only a name. Classic keeps its four dialogs.
 */
export default function DeskNewProject({ hosts, onCreate, onAddHost, onCancel }: Props): React.ReactElement {
  const usable = useMemo(() => hosts.filter(newProjectHostUsable), [hosts])
  const [hostKey, setHostKey] = useState(MAC_HOST_KEY)
  const host = usable.find(h => h.key === hostKey) ?? usable[0]
  const canMake = host.kind === 'mac' || host.kind === 'server'
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const making = canMake && mode === 'new'
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The host's projects folder for a new folder; null while it loads. */
  const [projectsDir, setProjectsDir] = useState<string | null>(null)
  /** Browsing a server's folders: for the projects folder (new) or the project's folder (existing). */
  const [browsing, setBrowsing] = useState(false)
  const [serverPick, setServerPick] = useState('')
  const serverId = host.kind === 'server' ? host.server?.id ?? null : null
  const hostId = host.kind === 'mac' ? 'local' : serverId

  useEffect(() => {
    if (!hostId) return
    let cancelled = false
    setProjectsDir(null)
    window.api.projectsFolder(hostId)
      .then(dir => { if (!cancelled) setProjectsDir(dir) })
      .catch((err: unknown) => { if (!cancelled) { setProjectsDir(''); setError(ipcErrorMessage(err)) } })
    return () => { cancelled = true }
  }, [hostId])

  const pickHost = (key: string): void => {
    if (key === ADD_HOST) { onAddHost(); return }
    setHostKey(key)
    setFolder('')
    setBrowsing(false)
    setError(null)
  }

  const sep = host.kind === 'mac' && window.api.platform === 'win32' ? '\\' : '/'
  const target = making && projectsDir && name.trim() ? `${projectsDir.replace(/[\\/]+$/, '')}${sep}${name.trim()}` : ''
  const valid = !busy && (
    host.kind === 'shell' ? !!name.trim()
      : making ? !!projectsDir && !!name.trim()
        : !!folder.trim() && !!(name.trim() || folderName(folder))
  )

  const saveProjectsDir = async (dir: string): Promise<void> => {
    if (!hostId) return
    try {
      setProjectsDir(await window.api.setProjectsFolder(hostId, dir))
      setError(null)
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  const browse = async (): Promise<void> => {
    if (host.kind === 'server') { setBrowsing(open => !open); return }
    const picked = await window.api.pickDirectory().catch(() => null)
    if (!picked) return
    if (making) await saveProjectsDir(picked)
    else setFolder(picked)
  }

  const create = async (): Promise<void> => {
    if (!valid) return
    if (!making) { onCreate(host, name, folder); return }
    if (!hostId) return
    setBusy(true)
    setError(null)
    try {
      const directory = await window.api.createProjectDir(hostId, name.trim())
      onCreate(host, name.trim(), directory)
    } catch (err) {
      setError(ipcErrorMessage(err))
      setBusy(false)
    }
  }

  const hostOptions = [
    ...usable.map(h => ({ value: h.key, label: KIND_WORD[h.kind] ? `${h.label} · ${KIND_WORD[h.kind]}` : h.label })),
    { value: ADD_HOST, label: '+ Add a host…' }
  ]
  const offline = hosts.filter(h => !newProjectHostUsable(h))

  return (
    <Modal
      title="New Project"
      onClose={onCancel}
      footer={
        <>
          <LinkBtn onClick={onCancel}>Cancel</LinkBtn>
          <PrimaryButton onClick={() => { void create() }} disabled={!valid}>{making ? 'Create' : 'Add'}</PrimaryButton>
        </>
      }
    >
      <SetBlock label="Host">
        <ThemedSelect className="w-full" aria-label="Host" value={host.key} options={hostOptions} onChange={pickHost} disabled={busy} />
        <HelperText>
          {host.kind === 'ssh' ? `Tabs and agents run on ${host.sub} over SSH.`
            : host.kind === 'shell' ? <>Terminals open with <span className="font-mono">{host.command}</span>.</>
              : host.kind === 'server' ? `Runs on ${host.label}, even while this computer sleeps.`
                : offline.length > 0 ? `${offline.map(h => h.label).join(', ')} ${offline.length === 1 ? 'is' : 'are'} not online right now.`
                  : 'Servers, SSH boxes and shells are added in Settings › Hosts.'}
        </HelperText>
      </SetBlock>

      {canMake && (
        <SegCtl
          options={[{ value: 'new', label: 'New folder' }, { value: 'existing', label: 'Existing folder' }] as const}
          value={mode}
          onChange={(next) => { setMode(next); setBrowsing(false); setError(null) }}
          disabled={busy}
        />
      )}

      {host.kind !== 'shell' && !making && (
        <SetBlock label="Folder">
          <div className="flex gap-2">
            <Field
              className="flex-1"
              value={folder}
              autoFocus
              onChange={(e) => { setFolder(e.target.value); setError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
              placeholder={host.kind === 'ssh' ? `/home/${host.ssh?.username || 'me'}/my-project` : '/path/to/project'}
            />
            {host.kind !== 'ssh' && (
              <button
                type="button"
                className="h-(--ctl-h) px-2.5 rounded-md bg-field text-text-muted hover:text-text border border-border cursor-pointer text-base"
                onClick={() => { void browse() }}
                title="Browse"
              >…</button>
            )}
          </div>
          {browsing && serverId && (
            <ServerPick serverId={serverId} initialDir={folder} onCancel={() => setBrowsing(false)} onPick={(dir) => { setBrowsing(false); setFolder(dir) }} pick={serverPick} setPick={setServerPick} />
          )}
        </SetBlock>
      )}

      <SetBlock label={host.kind === 'shell' || making ? 'Project name' : 'Name (optional)'}>
        <Field
          value={name}
          autoFocus={host.kind === 'shell' || making}
          onChange={(e) => { setName(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
          placeholder={!making && folderName(folder) ? folderName(folder) : 'my-project'}
        />
      </SetBlock>

      {making && (
        <SetBlock label="Projects folder">
          <div className="flex items-center gap-2.5">
            <span className="flex-1 min-w-0 truncate text-sm text-text-muted" title={projectsDir ?? ''}>
              {projectsDir === null ? 'Loading…' : projectsDir || 'Not set'}
            </span>
            <LinkBtn onClick={() => { void browse() }} disabled={projectsDir === null || busy}>
              {projectsDir ? 'Change…' : 'Choose…'}
            </LinkBtn>
          </div>
          {browsing && serverId && (
            <ServerPick serverId={serverId} initialDir={projectsDir ?? ''} onCancel={() => setBrowsing(false)} onPick={(dir) => { setBrowsing(false); void saveProjectsDir(dir) }} pick={serverPick} setPick={setServerPick} />
          )}
          <HelperText>
            {target
              ? <>Creates <span className="font-mono">{target}</span> and runs <span className="font-mono">git init</span> in it.</>
              : 'The new folder goes here, and git init runs in it.'}
          </HelperText>
        </SetBlock>
      )}

      {error && <div className="text-danger text-sm mt-2" role="alert">{error}</div>}
    </Modal>
  )
}

function ServerPick({ serverId, initialDir, pick, setPick, onPick, onCancel }: {
  serverId: string
  initialDir: string
  pick: string
  setPick: (dir: string) => void
  onPick: (dir: string) => void
  onCancel: () => void
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2 mt-2">
      <ServerFolderList serverId={serverId} initialDir={initialDir} onListing={(listing) => setPick(listing.path)} />
      <div className="flex items-center justify-end gap-3">
        <LinkBtn onClick={onCancel}>Cancel</LinkBtn>
        <PrimaryButton disabled={!pick} onClick={() => onPick(pick)}>Use this folder</PrimaryButton>
      </div>
    </div>
  )
}

import React, { useEffect, useState } from 'react'
import type { Tag } from '../../shared/types'
import TagPicker from './TagPicker'
import ServerFolderList from './servers/ServerFolderList'
import { Modal, SetBlock, Field, HelperText, LinkBtn, PrimaryButton, SegCtl } from './ui'
import { ipcErrorMessage } from '../utils/ipcErrorMessage'

/** Where a new project can go: this computer, or a paired DevTool server that is online. */
export interface NewProjectHost {
  /** `local` or a server id. */
  id: string
  label: string
}

interface Props {
  /** This computer first, then online servers. */
  hosts: readonly NewProjectHost[]
  /** Called with the folder the host made and `git init`ed. */
  onCreated: (host: string, name: string, directory: string, tagIds?: string[]) => void
  onCancel: () => void
  allTags: readonly Tag[]
  onEnsureTag: (name: string) => string
}

/**
 * A brand-new project: a fresh folder under the chosen host's projects folder,
 * with `git init` run in it. Each host keeps its own projects folder (a server
 * starts at `~/code`); Change… sets it there.
 */
export default function NewProjectModal({ hosts, onCreated, onCancel, allTags, onEnsureTag }: Props): React.ReactElement {
  const [host, setHost] = useState(hosts[0]?.id ?? 'local')
  const [name, setName] = useState('')
  const [tagIds, setTagIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The host's projects folder; null while it loads. */
  const [projectsDir, setProjectsDir] = useState<string | null>(null)
  /** Browsing a server's folders for a new projects folder, and the folder shown. */
  const [browsing, setBrowsing] = useState(false)
  const [serverPick, setServerPick] = useState('')

  useEffect(() => {
    let cancelled = false
    setProjectsDir(null)
    setBrowsing(false)
    window.api.projectsFolder(host)
      .then(dir => { if (!cancelled) setProjectsDir(dir) })
      .catch((err: unknown) => { if (!cancelled) { setProjectsDir(''); setError(ipcErrorMessage(err)) } })
    return () => { cancelled = true }
  }, [host])

  const local = host === 'local'
  const sep = local && window.api.platform === 'win32' ? '\\' : '/'
  const target = projectsDir && name.trim() ? `${projectsDir.replace(/[\\/]+$/, '')}${sep}${name.trim()}` : ''
  const isValid = !!projectsDir && !!name.trim() && !busy

  const saveProjectsDir = async (dir: string) => {
    try {
      setProjectsDir(await window.api.setProjectsFolder(host, dir))
      setError(null)
    } catch (err) {
      setError(ipcErrorMessage(err))
    }
  }

  const changeProjectsDir = async () => {
    if (!local) {
      setBrowsing(open => !open)
      return
    }
    const picked = await window.api.pickDirectory().catch(() => null)
    if (picked) await saveProjectsDir(picked)
  }

  const handleCreate = async () => {
    if (!isValid) return
    setBusy(true)
    setError(null)
    try {
      const directory = await window.api.createProjectDir(host, name.trim())
      onCreated(host, name.trim(), directory, tagIds.length > 0 ? tagIds : undefined)
    } catch (err) {
      setError(ipcErrorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New Project"
      onClose={onCancel}
      footer={
        <>
          <LinkBtn onClick={onCancel}>Cancel</LinkBtn>
          <PrimaryButton onClick={() => { void handleCreate() }} disabled={!isValid}>Create</PrimaryButton>
        </>
      }
    >
      <SetBlock label="Project name">
        <Field
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }}
          placeholder="my-project"
          autoFocus
        />
      </SetBlock>

      {hosts.length > 1 && (
        <SetBlock label="Where">
          <SegCtl
            options={hosts.map(h => ({ value: h.id, label: h.label }))}
            value={host}
            onChange={(next) => { setHost(next); setError(null) }}
            disabled={busy}
          />
        </SetBlock>
      )}

      <SetBlock label="Projects folder">
        <div className="flex items-center gap-2.5">
          <span className="flex-1 min-w-0 truncate text-sm text-text-muted" title={projectsDir ?? ''}>
            {projectsDir === null ? 'Loading…' : projectsDir || 'Not set'}
          </span>
          <LinkBtn onClick={() => { void changeProjectsDir() }} disabled={projectsDir === null || busy}>
            {projectsDir ? 'Change…' : 'Choose…'}
          </LinkBtn>
        </div>
        {browsing && !local && (
          <div className="flex flex-col gap-2 mt-2">
            <ServerFolderList serverId={host} initialDir={projectsDir ?? ''} onListing={(listing) => setServerPick(listing.path)} />
            <div className="flex items-center justify-end gap-3">
              <LinkBtn onClick={() => setBrowsing(false)}>Cancel</LinkBtn>
              <PrimaryButton
                disabled={!serverPick}
                onClick={() => { setBrowsing(false); void saveProjectsDir(serverPick) }}
              >Use this folder</PrimaryButton>
            </div>
          </div>
        )}
        <HelperText>
          {target
            ? <>Creates <span className="font-mono">{target}</span> and runs <span className="font-mono">git init</span> in it.</>
            : local
              ? 'The new folder goes here, and git init runs in it. Also in Settings → Sidebar.'
              : 'The new folder goes here on the server, and git init runs in it.'}
        </HelperText>
      </SetBlock>

      <TagPicker
        selectedTagIds={tagIds}
        onChange={setTagIds}
        allTags={allTags}
        onEnsureTag={onEnsureTag}
      />

      {error && <div className="text-danger text-sm mt-2" role="alert">{error}</div>}
    </Modal>
  )
}

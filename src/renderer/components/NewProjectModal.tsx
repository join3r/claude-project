import React, { useState } from 'react'
import type { Tag } from '../../shared/types'
import TagPicker from './TagPicker'
import { Modal, SetBlock, Field, HelperText, LinkBtn, PrimaryButton } from './ui'
import { ipcErrorMessage } from '../utils/ipcErrorMessage'

interface Props {
  /** Settings → Projects folder; empty until picked (here or in Settings). */
  projectsDir: string
  onChangeProjectsDir: (dir: string) => void
  /** Called with the folder main made and `git init`ed. */
  onCreated: (name: string, directory: string, tagIds?: string[]) => void
  onCancel: () => void
  allTags: readonly Tag[]
  onEnsureTag: (name: string) => string
}

/** A brand-new project: a fresh folder under the projects folder, with `git init` run in it. */
export default function NewProjectModal({ projectsDir, onChangeProjectsDir, onCreated, onCancel, allTags, onEnsureTag }: Props): React.ReactElement {
  const [name, setName] = useState('')
  const [tagIds, setTagIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const sep = window.api.platform === 'win32' ? '\\' : '/'
  const target = projectsDir && name.trim() ? `${projectsDir.replace(/[\\/]+$/, '')}${sep}${name.trim()}` : ''
  const isValid = !!projectsDir && !!name.trim() && !busy

  const pickProjectsDir = async () => {
    const picked = await window.api.pickDirectory().catch(() => null)
    if (picked) onChangeProjectsDir(picked)
  }

  const handleCreate = async () => {
    if (!isValid) return
    setBusy(true)
    setError(null)
    try {
      const directory = await window.api.createProjectDir(name.trim())
      onCreated(name.trim(), directory, tagIds.length > 0 ? tagIds : undefined)
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

      <SetBlock label="Projects folder">
        <div className="flex items-center gap-2.5">
          <span className="flex-1 min-w-0 truncate text-sm text-text-muted" title={projectsDir}>
            {projectsDir || 'Not set'}
          </span>
          <LinkBtn onClick={() => { void pickProjectsDir() }}>{projectsDir ? 'Change…' : 'Choose…'}</LinkBtn>
        </div>
        <HelperText>
          {target
            ? <>Creates <span className="font-mono">{target}</span> and runs <span className="font-mono">git init</span> in it.</>
            : 'The new folder goes here, and git init runs in it. Also in Settings → Sidebar.'}
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

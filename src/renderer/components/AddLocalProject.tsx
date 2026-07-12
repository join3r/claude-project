import React, { useState } from 'react'
import type { Tag } from '../../shared/types'
import TagPicker from './TagPicker'
import { Modal, SetBlock, Field, LinkBtn, PrimaryButton } from './ui'

interface Props {
  onAdd: (name: string, directory: string, tagIds?: string[]) => void
  onCancel: () => void
  initialValues: {
    name: string
    directory: string
  }
  allTags: readonly Tag[]
  onEnsureTag: (name: string) => string
}

export default function AddLocalProject({ onAdd, onCancel, initialValues, allTags, onEnsureTag }: Props): React.ReactElement {
  const [name, setName] = useState(initialValues.name)
  const [directory, setDirectory] = useState(initialValues.directory)
  const [tagIds, setTagIds] = useState<string[]>([])

  const isValid = name.trim() && directory.trim()

  const handleAdd = () => {
    if (!isValid) return
    onAdd(name.trim(), directory.trim(), tagIds.length > 0 ? tagIds : undefined)
  }

  const handlePickDir = async () => {
    const picked = await window.api.pickDirectory()
    if (picked) setDirectory(picked)
  }

  return (
    <Modal
      title="Duplicate Local Project"
      onClose={onCancel}
      footer={
        <>
          <LinkBtn onClick={onCancel}>Cancel</LinkBtn>
          <PrimaryButton onClick={handleAdd} disabled={!isValid}>Add</PrimaryButton>
        </>
      }
    >
      <SetBlock label="Project name">
        <Field
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Project"
          autoFocus
        />
      </SetBlock>

      <SetBlock label="Directory">
        <div className="flex gap-2">
          <Field
            className="flex-1"
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder="/path/to/project"
          />
          <button
            className="h-(--ctl-h) px-2.5 rounded-md bg-field text-text-muted hover:text-text border border-border cursor-pointer text-base"
            onClick={handlePickDir}
            title="Browse"
          >
            …
          </button>
        </div>
      </SetBlock>

      <TagPicker
        selectedTagIds={tagIds}
        onChange={setTagIds}
        allTags={allTags}
        onEnsureTag={onEnsureTag}
      />
    </Modal>
  )
}

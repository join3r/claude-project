import React, { useState } from 'react'
import type { Tag } from '../../shared/types'
import TagPicker from './TagPicker'
import { Modal, SetBlock, Field, LinkBtn, PrimaryButton } from './ui'

interface Props {
  onAdd: (name: string, command: string, tagIds?: string[]) => void
  onCancel: () => void
  allTags: readonly Tag[]
  onEnsureTag: (name: string) => string
  initialValues?: {
    name: string
    command: string
  }
}

export default function AddShellCommandProject({ onAdd, onCancel, initialValues, allTags, onEnsureTag }: Props): React.ReactElement {
  const [name, setName] = useState(initialValues?.name ?? '')
  const [command, setCommand] = useState(initialValues?.command ?? '')
  const [tagIds, setTagIds] = useState<string[]>([])

  const isValid = name.trim() && command.trim()

  const handleAdd = () => {
    if (!isValid) return
    onAdd(name.trim(), command.trim(), tagIds.length > 0 ? tagIds : undefined)
  }

  return (
    <Modal
      title={`${initialValues ? 'Duplicate' : 'Add'} Custom Shell Project`}
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
          placeholder="My Container"
          autoFocus
        />
      </SetBlock>

      <SetBlock label="Shell command">
        <Field
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="docker exec -it mycontainer /bin/bash"
        />
        <div className="text-sm text-text-muted mt-1 flex flex-col gap-0.5">
          <p className="m-0 mb-1">Examples:</p>
          <code className="block py-px text-xs text-text-muted opacity-80 font-mono">docker exec -it mycontainer /bin/bash</code>
          <code className="block py-px text-xs text-text-muted opacity-80 font-mono">docker exec -w /app -it mycontainer /bin/sh</code>
          <code className="block py-px text-xs text-text-muted opacity-80 font-mono">orb shell -m vm-name bash -c &quot;cd dir &amp;&amp; bash&quot;</code>
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

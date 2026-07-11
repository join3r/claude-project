import React, { useState } from 'react'
import type { Tag } from '../../shared/types'
import TagPicker from './TagPicker'

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-surface-2 shadow-2xl flex flex-col max-h-[85vh]">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[14px] font-semibold text-text m-0">
            {initialValues ? 'Duplicate' : 'Add'} Custom Shell Project
          </h2>
          <button
            className="bg-transparent border-0 text-text-muted cursor-pointer text-[18px] leading-none px-1 rounded-sm hover:text-text"
            onClick={onCancel}
          >
            &times;
          </button>
        </header>

        <div className="p-5 flex flex-col gap-4 overflow-y-auto">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Project Name</span>
            <input
              className="h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Container"
              autoFocus
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Shell Command</span>
            <input
              className="h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="docker exec -it mycontainer /bin/bash"
            />
            <div className="text-[12px] text-text-muted mt-2 flex flex-col gap-0.5">
              <p className="m-0 mb-1">Examples:</p>
              <code className="block py-px text-[11px] text-text-muted opacity-80 font-mono">docker exec -it mycontainer /bin/bash</code>
              <code className="block py-px text-[11px] text-text-muted opacity-80 font-mono">docker exec -w /app -it mycontainer /bin/sh</code>
              <code className="block py-px text-[11px] text-text-muted opacity-80 font-mono">orb shell -m vm-name bash -c &quot;cd dir &amp;&amp; bash&quot;</code>
            </div>
          </label>

          <TagPicker
            selectedTagIds={tagIds}
            onChange={setTagIds}
            allTags={allTags}
            onEnsureTag={onEnsureTag}
          />
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-accent-500 text-accent-50 hover:bg-accent-400 border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleAdd}
            disabled={!isValid}
          >
            Add
          </button>
        </footer>
      </div>
    </div>
  )
}

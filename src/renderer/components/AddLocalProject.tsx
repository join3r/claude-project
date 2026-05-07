import React, { useState } from 'react'

interface Props {
  onAdd: (name: string, directory: string) => void
  onCancel: () => void
  initialValues: {
    name: string
    directory: string
  }
}

export default function AddLocalProject({ onAdd, onCancel, initialValues }: Props): React.ReactElement {
  const [name, setName] = useState(initialValues.name)
  const [directory, setDirectory] = useState(initialValues.directory)

  const isValid = name.trim() && directory.trim()

  const handleAdd = () => {
    if (!isValid) return
    onAdd(name.trim(), directory.trim())
  }

  const handlePickDir = async () => {
    const picked = await window.api.pickDirectory()
    if (picked) setDirectory(picked)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-surface-2 shadow-2xl flex flex-col max-h-[85vh]">
        <header className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[14px] font-semibold text-text m-0">Duplicate Local Project</h2>
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
              placeholder="My Project"
              autoFocus
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Directory</span>
            <div className="flex gap-2">
              <input
                className="flex-1 h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="/path/to/project"
              />
              <button
                className="h-9 px-3 rounded-md bg-surface-3 text-text hover:bg-surface-2 border border-border cursor-pointer"
                onClick={handlePickDir}
                title="Browse"
              >
                ...
              </button>
            </div>
          </label>
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

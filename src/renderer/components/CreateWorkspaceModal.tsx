import React, { useState, useEffect } from 'react'
import type { SshConfig, WorkspaceConfig } from '../../shared/types'

interface Props {
  projectDir: string
  projectId?: string
  sshConfig?: SshConfig
  onAdd: (name: string, workspace: WorkspaceConfig) => void
  onCancel: () => void
}

export default function CreateWorkspaceModal({ projectDir, projectId, sshConfig, onAdd, onCancel }: Props): React.ReactElement {
  const [name, setName] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [selectedBranch, setSelectedBranch] = useState('')
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    window.api.workspaceListBranches({ projectDir, projectId, sshConfig })
      .then(branchList => {
        setBranches(branchList)
        const defaultBranch = branchList.find(b => b === 'main') ?? branchList.find(b => b === 'master') ?? branchList[0] ?? ''
        setSelectedBranch(defaultBranch)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to list branches. Is this a git repository?')
      })
  }, [projectDir, projectId, sshConfig])

  const filteredBranches = filter
    ? branches.filter(b => b.toLowerCase().includes(filter.toLowerCase()))
    : branches

  const handleCreate = async () => {
    if (!name.trim() || !selectedBranch) return
    setCreating(true)
    setError('')
    try {
      const result = await window.api.workspaceCreate({
        projectDir,
        projectId,
        sshConfig,
        name: name.trim(),
        baseBranch: selectedBranch
      })
      onAdd(name.trim(), {
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch: selectedBranch,
        relativeProjectPath: result.relativeProjectPath
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
      setCreating(false)
    }
  }

  const isValid = name.trim().length > 0 && selectedBranch.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[440px] max-w-[90vw] rounded-xl border border-border bg-surface-2 shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-[14px] font-semibold text-text m-0">Create Workspace</h2>
          <button
            className="bg-transparent border-0 text-text-muted cursor-pointer text-[18px] leading-none px-1 rounded-sm hover:text-text"
            onClick={onCancel}
          >
            &times;
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4 overflow-y-auto">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Workspace Name</span>
            <input
              className="h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="feature-name"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && isValid && !creating) handleCreate() }}
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-subtle">Base Branch</span>
            <input
              className="h-9 px-3 rounded-md bg-surface-2 border border-border text-text focus:border-border-focus outline-none mb-1"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter branches..."
            />
            <div className="max-h-[200px] overflow-y-auto rounded-md border border-border bg-surface">
              {filteredBranches.length === 0 && (
                <div className="px-3 py-2 text-[12px] text-text-muted">
                  {branches.length === 0 ? 'Loading...' : 'No matching branches'}
                </div>
              )}
              {filteredBranches.map(branch => (
                <button
                  key={branch}
                  className="block w-full px-3 py-1.5 text-left text-[13px] text-text bg-transparent border-0 cursor-pointer hover:bg-surface-2 data-[selected=true]:relative data-[selected=true]:before:absolute data-[selected=true]:before:inset-y-0 data-[selected=true]:before:left-0 data-[selected=true]:before:w-0.5 data-[selected=true]:before:bg-accent-400 data-[selected=true]:bg-gradient-to-r data-[selected=true]:from-accent-600/30 data-[selected=true]:to-transparent data-[selected=true]:text-accent-50 [.theme-light_&[data-selected=true]]:from-accent-200 [.theme-light_&[data-selected=true]]:text-accent-700"
                  data-selected={branch === selectedBranch ? 'true' : undefined}
                  onClick={() => setSelectedBranch(branch)}
                >
                  {branch}
                </button>
              ))}
            </div>
          </div>

          {error && <div className="text-[12px] text-red-400">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-surface-3 text-text hover:bg-surface-2 border border-border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-accent-500 text-accent-50 hover:bg-accent-400 border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleCreate}
            disabled={!isValid || creating}
          >
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

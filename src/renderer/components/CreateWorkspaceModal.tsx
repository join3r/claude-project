import React, { useState, useEffect } from 'react'
import type { SshConfig, WorkspaceConfig } from '../../shared/types'
import './CreateWorkspaceModal.css'

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
    <div className="settings-overlay" onClick={onCancel}>
      <div className="settings-panel create-workspace-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Create Workspace</h2>
          <button className="settings-close" onClick={onCancel}>&times;</button>
        </div>

        <div className="settings-body">
          <div className="settings-group">
            <label className="settings-label">Workspace Name</label>
            <input
              className="settings-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="feature-name"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && isValid && !creating) handleCreate() }}
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Base Branch</label>
            <input
              className="settings-input create-workspace-branch-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter branches..."
            />
            <div className="create-workspace-branch-list">
              {filteredBranches.length === 0 && (
                <div className="create-workspace-branch-empty">
                  {branches.length === 0 ? 'Loading...' : 'No matching branches'}
                </div>
              )}
              {filteredBranches.map(branch => (
                <button
                  key={branch}
                  className={`create-workspace-branch-item ${branch === selectedBranch ? 'selected' : ''}`}
                  onClick={() => setSelectedBranch(branch)}
                >
                  {branch}
                </button>
              ))}
            </div>
          </div>

          {error && <div className="add-remote-error">{error}</div>}

          <div className="create-workspace-actions">
            <button
              className="add-remote-btn add-remote-btn-secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              className="add-remote-btn add-remote-btn-primary"
              onClick={handleCreate}
              disabled={!isValid || creating}
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

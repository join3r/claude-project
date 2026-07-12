import React, { useState, useEffect } from 'react'
import type { SshConfig, WorkspaceConfig } from '../../shared/types'
import { Modal, SetBlock, Field, LinkBtn, PrimaryButton, HelperText } from './ui'

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
    <Modal
      title="Create Workspace"
      onClose={onCancel}
      footer={
        <>
          <LinkBtn onClick={onCancel}>Cancel</LinkBtn>
          <PrimaryButton onClick={() => void handleCreate()} disabled={!isValid || creating}>
            {creating ? 'Creating…' : 'Create'}
          </PrimaryButton>
        </>
      }
    >
      <SetBlock label="Workspace name">
        <Field
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="feature-name"
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && isValid && !creating) void handleCreate() }}
        />
      </SetBlock>

      <SetBlock label="Base branch">
        <Field
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter branches…"
        />
        <div className="max-h-[200px] overflow-y-auto rounded-md border border-border bg-field p-1">
          {filteredBranches.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-text-muted">
              {branches.length === 0 ? 'Loading…' : 'No matching branches'}
            </div>
          )}
          {filteredBranches.map(branch => (
            <button
              key={branch}
              className={`block w-full rounded-md px-2 py-1 text-left text-base text-text bg-transparent border-0 cursor-pointer ${branch === selectedBranch ? 'bg-sel' : 'hover:bg-surface-3'}`}
              onClick={() => setSelectedBranch(branch)}
            >
              {branch}
            </button>
          ))}
        </div>
      </SetBlock>

      {error && <HelperText><span className="text-danger">{error}</span></HelperText>}
    </Modal>
  )
}

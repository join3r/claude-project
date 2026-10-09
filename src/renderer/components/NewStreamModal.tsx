import React, { useEffect, useRef, useState } from 'react'
import type { PendingWorktreeSetup, Project, WorkspaceConfig } from '../../shared/types'
import { getProjectDir } from '../hooks/appState/projectsData'
import { defaultBaseBranch } from '../../shared/branch-name'
import { Field, HelperText, LinkBtn, Modal, PrimaryButton, SegCtl, Select } from './ui'
import { defaultStreamBranch, streamWorktreeSupported, suggestStreamName } from './newStream'

interface Props {
  project: Project
  /** `setupPending`: the worktree's setup commands wait for the user's yes. */
  onCreate: (name: string, workspace?: WorkspaceConfig, setupPending?: PendingWorktreeSetup) => void
  onClose: () => void
}

type Place = 'worktree' | 'folder'

/**
 * New stream: a free-text name (prefilled with the next version when the last
 * stream is one), and where it works: a new worktree (branch defaults to the
 * name, forked from a base branch) or the project folder.
 */
export default function NewStreamModal({ project, onCreate, onClose }: Props): React.ReactElement {
  const suggestion = useRef(suggestStreamName(project)).current
  const worktreeSupported = streamWorktreeSupported(project)
  const [name, setName] = useState(suggestion.name)
  const [place, setPlace] = useState<Place>(worktreeSupported ? 'worktree' : 'folder')
  // The branch follows the name until it is edited by hand.
  const [branch, setBranch] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [baseBranch, setBaseBranch] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const worktree = place === 'worktree' && worktreeSupported
  const branchName = branch ?? defaultStreamBranch(name)
  const target = {
    projectDir: getProjectDir(project),
    projectId: project.id,
    sshConfig: project.ssh
  }

  // Branches are listed once a worktree is asked for (over SSH too).
  useEffect(() => {
    if (!worktree) return
    let cancelled = false
    setBranchesLoading(true)
    setError('')
    window.api.workspaceListBranches(target)
      .then(listed => {
        if (cancelled) return
        const list = Array.isArray(listed) ? listed : []
        setBranches(list)
        setBaseBranch(prev => (prev && list.includes(prev) ? prev : defaultBaseBranch(list)))
      })
      .catch(err => {
        if (cancelled) return
        setBranches([])
        setError(err instanceof Error ? err.message : 'Failed to list branches. Is this a git repository?')
      })
      .finally(() => { if (!cancelled) setBranchesLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree, project.id])

  const valid = !!name.trim() && (!worktree || (!!branchName.trim() && !!baseBranch))

  const create = async (): Promise<void> => {
    if (!valid || creating) return
    if (!worktree) {
      onCreate(name.trim())
      return
    }
    setCreating(true)
    setError('')
    try {
      const result = await window.api.workspaceCreate({ ...target, name: branchName.trim(), baseBranch })
      const workspace: WorkspaceConfig = {
        worktreePath: result.worktreePath,
        branchName: result.branchName,
        baseBranch,
        relativeProjectPath: result.relativeProjectPath
      }
      // Even when the dialog went away while git worked: the stream was asked for.
      onCreate(name.trim(), workspace, result.setupPending)
      // The worktree is there and the stream works; say what setup didn't do.
      if (result.setupError) window.alert(`The worktree was created, but its setup failed:\n\n${result.setupError}`)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to create the worktree')
      setCreating(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void create()
    }
  }

  return (
    <Modal
      title={`New stream in ${project.name}`}
      onClose={() => { if (!creating) onClose() }}
      footer={
        <>
          <LinkBtn onClick={onClose} disabled={creating}>Cancel</LinkBtn>
          <PrimaryButton onClick={() => void create()} disabled={!valid || creating}>
            {creating ? 'Creating…' : 'Create stream'}
          </PrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-text-muted" htmlFor="new-stream-name">Name</label>
        <Field
          id="new-stream-name"
          aria-label="Stream name"
          value={name}
          autoFocus
          placeholder="0.5.0, bugfixes, …"
          disabled={creating}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {suggestion.minor && name !== suggestion.minor && (
          <HelperText>
            Next minor:{' '}
            <LinkBtn onClick={() => setName(suggestion.minor!)} disabled={creating}>
              <span className="font-mono">{suggestion.minor}</span>
            </LinkBtn>
          </HelperText>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-text-muted">Works in</span>
        <SegCtl
          options={[
            { value: 'worktree', label: 'New worktree' },
            { value: 'folder', label: 'Project folder' }
          ] as const}
          value={worktree ? 'worktree' : 'folder'}
          disabled={!worktreeSupported || creating}
          onChange={(value) => setPlace(value)}
        />
        {!worktreeSupported && <HelperText>Custom shell projects have no folder to make a worktree in.</HelperText>}
      </div>

      {worktree && (
        <div className="flex gap-2">
          <div className="flex flex-col gap-1.5 flex-1 min-w-0">
            <label className="text-sm text-text-muted" htmlFor="new-stream-branch">Branch</label>
            <Field
              id="new-stream-branch"
              aria-label="Branch"
              className="font-mono"
              value={branchName}
              disabled={creating}
              onChange={(e) => setBranch(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className="flex flex-col gap-1.5 w-40 shrink-0">
            <label className="text-sm text-text-muted" htmlFor="new-stream-base">From</label>
            <Select
              id="new-stream-base"
              aria-label="Base branch"
              value={baseBranch}
              disabled={creating || branches.length === 0}
              onChange={(e) => setBaseBranch(e.target.value)}
            >
              {branches.length === 0 && <option value="">{branchesLoading ? '…' : 'no branch'}</option>}
              {branches.map(b => <option key={b} value={b}>{b}</option>)}
            </Select>
          </div>
        </div>
      )}

      {error ? (
        <HelperText><span className="text-danger">{error}</span></HelperText>
      ) : creating ? (
        <HelperText>Creating worktree <span className="font-mono">{branchName}</span>…</HelperText>
      ) : worktree && !branchesLoading && branches.length === 0 ? (
        <HelperText>No branch to fork a worktree from. Is this a git repository with a commit?</HelperText>
      ) : (
        <HelperText>
          {worktree
            ? 'The stream gets its own worktree on a new branch. Renaming the stream later keeps the branch.'
            : 'The stream works in the project folder, like main.'}
        </HelperText>
      )}
    </Modal>
  )
}

import React, { useEffect, useState } from 'react'
import type { Project } from '../../shared/types'
import { Modal, SetBlock, Field, HelperText, LinkBtn, PrimaryButton, Switch } from './ui'
import { ipcErrorMessage } from '../utils/ipcErrorMessage'

type RenameCheck = Awaited<ReturnType<typeof window.api.renameProjectCheck>>

interface Props {
  project: Project
  /** The folder is gone: only the name can change. */
  folderMissing: boolean
  /** The name-only rename (the sidebar's own). */
  onRenameOnly: (name: string) => void
  onClose: () => void
}

function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

/** "2 terminals, 1 agent and 3 chats" */
export function runningSummary(running: RenameCheck['running']): string {
  const parts = [
    running.terminals > 0 ? `${running.terminals} terminal${running.terminals === 1 ? '' : 's'}` : '',
    running.agents > 0 ? `${running.agents} agent${running.agents === 1 ? '' : 's'}` : '',
    running.chats > 0 ? `${running.chats} chat${running.chats === 1 ? '' : 's'}` : ''
  ].filter(Boolean)
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? ''
}

/**
 * Rename… for a project with a folder: the name, and the folder with it when
 * "Also rename the folder" is on (on by default while the two match). The host
 * says up front what would stop the rename or which running tabs it stops; those
 * start again in the new folder, and Claude and Pi chats keep their history.
 */
export default function RenameProjectModal({ project, folderMissing, onRenameOnly, onClose }: Props): React.ReactElement {
  const [name, setName] = useState(project.name)
  const [folder, setFolder] = useState(!folderMissing && folderName(project.directory) === project.name)
  const [check, setCheck] = useState<RenameCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const renamesFolder = folder && trimmed !== '' && trimmed !== folderName(project.directory)

  useEffect(() => {
    setCheck(null)
    setError(null)
    if (!renamesFolder) return
    let cancelled = false
    setChecking(true)
    const timer = window.setTimeout(() => {
      window.api.renameProjectCheck(project.id, { name: trimmed, folder: true })
        .then(result => { if (!cancelled) setCheck(result) })
        .catch((err: unknown) => { if (!cancelled) setError(ipcErrorMessage(err)) })
        .finally(() => { if (!cancelled) setChecking(false) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [project.id, trimmed, renamesFolder])

  const runningCount = check ? check.running.terminals + check.running.agents + check.running.chats : 0
  const blocked = !!check && check.blockers.length > 0
  const canSubmit = trimmed !== '' && !busy && (!renamesFolder || (!!check && !blocked && !checking && !error))

  const submit = async () => {
    if (!canSubmit) return
    if (!renamesFolder) {
      if (trimmed !== project.name) onRenameOnly(trimmed)
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Tabs can start after the dialog checked: never stop more than it said.
      const fresh = await window.api.renameProjectCheck(project.id, { name: trimmed, folder: true })
      const freshCount = fresh.running.terminals + fresh.running.agents + fresh.running.chats
      if (fresh.blockers.length > 0 || freshCount > runningCount) {
        setCheck(fresh)
        setBusy(false)
        return
      }
      const result = await window.api.renameProjectFolder(project.id, { name: trimmed, folder: true, stop: freshCount > 0 })
      if (result.warnings.length > 0) window.alert(`Renamed to ${result.directory}, with problems:\n\n${result.warnings.join('\n')}`)
      onClose()
    } catch (err) {
      setError(ipcErrorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Rename Project"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <LinkBtn onClick={onClose} disabled={busy}>Cancel</LinkBtn>
          <PrimaryButton onClick={() => { void submit() }} disabled={!canSubmit}>
            {busy ? 'Renaming…' : renamesFolder && runningCount > 0 ? 'Stop and rename' : 'Rename'}
          </PrimaryButton>
        </>
      }
    >
      <SetBlock label="Name">
        <Field
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          autoFocus
          disabled={busy}
        />
      </SetBlock>

      <SetBlock label="Also rename the folder">
        <div className="flex items-center gap-3">
          <Switch checked={folder} onChange={setFolder} disabled={folderMissing || busy} />
          <span className="text-sm text-text-muted min-w-0 truncate font-mono" title={project.directory}>
            {renamesFolder && check ? `${folderName(project.directory)} → ${folderName(check.target)}` : folderName(project.directory)}
          </span>
        </div>
        <HelperText>
          {folderMissing
            ? 'The folder is gone, so only the name changes. Point the project at its new place in Project settings.'
            : renamesFolder
              ? 'Worktrees move along, and Claude and Pi keep their chat history for the new folder.'
              : 'Off: only the name in DevTool changes.'}
        </HelperText>
      </SetBlock>

      {renamesFolder && checking && <div className="text-sm text-text-muted">Checking…</div>}
      {renamesFolder && check && blocked && (
        <div className="text-sm text-danger flex flex-col gap-1" role="alert" data-testid="rename-blockers">
          {check.blockers.map(line => <div key={line}>{line}</div>)}
        </div>
      )}
      {renamesFolder && check && !blocked && runningCount > 0 && (
        <div className="text-sm text-text-muted" data-testid="rename-running">
          {runningSummary(check.running)} will stop and start again in the new folder when you next open {runningCount === 1 ? 'it' : 'them'}.
        </div>
      )}
      {error && <div className="text-danger text-sm mt-2" role="alert">{error}</div>}
    </Modal>
  )
}

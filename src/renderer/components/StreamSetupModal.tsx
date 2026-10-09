import React, { useState } from 'react'
import type { PendingWorktreeSetup, StreamSetupResult } from '../../shared/types'
import { SetupCommands } from './TaskWorktreePanel'
import { LinkBtn, Modal, PrimaryButton } from './ui'

interface Props {
  projectId: string
  streamId: string
  branch: string
  pending: PendingWorktreeSetup
  onClose: () => void
}

/**
 * A new stream's worktree is made; its repo's setup commands wait for a yes.
 * Closing the dialog while they run leaves them running; a failure still
 * shows up.
 */
export default function StreamSetupModal({ projectId, streamId, branch, pending: initial, onClose }: Props): React.ReactElement {
  const [pending, setPending] = useState(initial)
  const [running, setRunning] = useState(false)

  const run = async (): Promise<void> => {
    setRunning(true)
    const result: StreamSetupResult = await window.api.streamWorktreeSetupRun(projectId, streamId, pending)
      .catch((err: unknown) => ({ status: 'failed', error: err instanceof Error ? err.message : String(err) }))
    setRunning(false)
    if (result.status === 'needs-approval') {
      // The file changed since it was shown: show what it says now.
      setPending(result.pending)
      return
    }
    onClose()
    if (result.status === 'failed') window.alert(`The setup of the ${branch} worktree failed:\n\n${result.error}`)
  }

  return (
    <Modal
      title="Run the worktree setup?"
      width="w-[520px]"
      onClose={onClose}
      footer={
        <>
          <LinkBtn onClick={onClose} disabled={running}>Skip this time</LinkBtn>
          <PrimaryButton onClick={() => void run()} disabled={running}>{running ? 'Running setup…' : 'Run setup'}</PrimaryButton>
        </>
      }
    >
      <div className="text-sm text-text-muted">
        The <span className="font-mono">{branch}</span> worktree is ready.
      </div>
      <SetupCommands commands={pending.commands} />
    </Modal>
  )
}

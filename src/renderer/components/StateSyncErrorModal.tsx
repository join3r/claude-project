import React from 'react'
import { useApp } from '../context/AppContext'
import { Modal, PrimaryButton, HelperText } from './ui'

/**
 * Shown when this window gave up trying to persist a change because another window
 * kept winning the compare-and-swap. It is a modal rather than a log line on purpose:
 * what is on screen at that point is the saved state, not what the user just did, and
 * silently swapping the two is precisely the bug this whole mechanism exists to fix.
 */
export default function StateSyncErrorModal(): React.ReactElement | null {
  const { stateSyncError, dismissStateSyncError } = useApp()
  if (!stateSyncError) return null

  return (
    <Modal
      title="Changes could not be saved"
      onClose={dismissStateSyncError}
      footer={<PrimaryButton onClick={dismissStateSyncError}>OK</PrimaryButton>}
    >
      <HelperText>{stateSyncError}</HelperText>
    </Modal>
  )
}

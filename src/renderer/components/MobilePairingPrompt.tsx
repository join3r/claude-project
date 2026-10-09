import React, { useState } from 'react'
import { LinkBtn } from './ui'
import { useMobileSettingsVisible, useMobileState } from '../hooks/useMobileState'
import { stripBidi } from '../../shared/printable'

/**
 * App-wide, non-modal: a phone asked to pair while Settings → Mobile is not on
 * screen. It sits above modals so it also shows over other Settings tabs.
 * Settings → Mobile shows the same request in place of the pairing code, so
 * this stands down there.
 */
export default function MobilePairingPrompt(): React.ReactElement | null {
  const [state] = useMobileState()
  const settingsVisible = useMobileSettingsVisible()
  const [error, setError] = useState<string | null>(null)
  const pending = state?.pending ?? null
  if (!pending || settingsVisible) return null

  const act = (call: Promise<unknown>) => {
    setError(null)
    void call.catch(() => setError('That request is no longer pending.'))
  }

  return (
    <div
      role="alert"
      className="fixed bottom-4 right-4 z-(--z-alert) w-72 rounded-lg border border-border bg-surface shadow-pop px-3 py-2.5 flex flex-col gap-1.5"
    >
      <div className="text-base text-text">{stripBidi(pending.name)} wants to pair</div>
      <div className="text-sm text-text-muted">
        {pending.online ? 'It will see your projects, tasks and agent status.' : 'The phone is offline right now.'}
      </div>
      <div className="flex items-center gap-3 pt-0.5">
        <LinkBtn onClick={() => act(window.api.mobileAccept(pending.phoneId))}>Accept</LinkBtn>
        <LinkBtn danger onClick={() => act(window.api.mobileReject(pending.phoneId))}>Reject</LinkBtn>
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  )
}

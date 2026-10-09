import React, { useEffect, useRef, useState } from 'react'
import type { MobileConnectionState, MobileState, MobileUpdateSide } from '../../../shared/mobile'
import { FormGroup, Group, GroupRow, GrpHead, HelperText, InlineConfirm, LinkBtn, SetBlock, Switch } from '../ui'
import { RelayLine } from './RelaySettings'
import {
  formatCountdown,
  formatLastSeen,
  setMobileSettingsVisible,
  useMobileState,
  useNow
} from '../../hooks/useMobileState'
import { renderPairingQr } from './pairingQr'

function describeConnection(connection: MobileConnectionState): string {
  switch (connection.kind) {
    case 'disabled': return 'Off'
    case 'connecting': return 'Connecting to relay…'
    case 'online': return 'Connected to relay'
    case 'offline': return connection.error ? `Offline · ${connection.error}` : 'Offline'
  }
}

function connectionDot(connection: MobileConnectionState): string {
  switch (connection.kind) {
    case 'online': return 'bg-ssh-connected'
    case 'connecting': return 'bg-ssh-connecting'
    case 'offline': return 'bg-ssh-disconnected'
    default: return 'bg-status-exited'
  }
}

/** What to do when a phone and this desktop speak different protocol versions. */
function updateAdvice(update: MobileUpdateSide): string {
  return update === 'phone'
    ? 'Update DevTool on your iPhone. This desktop no longer talks to its version.'
    : 'This phone needs a newer DevTool on this computer. Update DevTool here.'
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // Electron prefixes rejected invokes with "Error invoking remote method '…': Error: ".
  return raw.replace(/^Error invoking remote method '[^']+': (\w+Error: )?/, '')
}

export default function MobileSettings({ onOpenRelay }: { onOpenRelay: () => void }): React.ReactElement {
  const [state, setState] = useMobileState()
  const [actionError, setActionError] = useState<string | null>(null)
  const [qr, setQr] = useState<{ uri: string; image: string | null } | null>(null)
  const [copied, setCopied] = useState(false)
  const pairSectionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMobileSettingsVisible(true)
    return () => setMobileSettingsVisible(false)
  }, [])

  const invite = state?.invite ?? null
  const now = useNow(!!invite || (state?.devices.length ?? 0) > 0)
  const inviteLive = !!invite && invite.exp * 1000 > now

  const inviteUri = invite?.uri ?? null
  useEffect(() => {
    if (!inviteUri) { setQr(null); return }
    let alive = true
    void renderPairingQr(inviteUri)
      .then(image => { if (alive) setQr({ uri: inviteUri, image }) })
      .catch(() => { if (alive) setQr({ uri: inviteUri, image: null }) })
    return () => { alive = false }
  }, [inviteUri])

  // Scanning consumes the code, so the request replaces the QR the user was
  // looking at. Keep that spot on screen if the panel is scrolled.
  const pendingId = state?.pending?.phoneId ?? null
  useEffect(() => {
    if (pendingId) pairSectionRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [pendingId])

  if (!state) return <div />

  const run = (action: () => Promise<MobileState | unknown>) => {
    setActionError(null)
    void action()
      .then(next => { if (next && typeof next === 'object' && 'connection' in next) setState(next as MobileState) })
      .catch(err => setActionError(errorMessage(err)))
  }

  const copyLink = (uri: string) => {
    void navigator.clipboard.writeText(uri).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  const pending = state.pending

  return (
    <>
      <GrpHead>Mobile</GrpHead>
      <Group>
        <GroupRow
          label="Connect phones to this desktop"
          sub={
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${connectionDot(state.connection)}`} />
              {describeConnection(state.connection)}
            </span>
          }
          trailing={<Switch checked={state.enabled} onChange={(enabled) => run(() => window.api.mobileSetEnabled(enabled))} />}
        />
      </Group>
      <HelperText>Paired phones see your projects, tasks and agent status. Traffic is end-to-end encrypted.</HelperText>

      <RelayLine onOpenRelay={onOpenRelay} />

      <GrpHead
        actions={inviteLive && !pending ? <LinkBtn onClick={() => run(() => window.api.mobileCancelPairing())}>Cancel</LinkBtn> : undefined}
      >
        Pair a phone
      </GrpHead>
      <FormGroup>
        <div ref={pairSectionRef}>
          {pending ? (
            <div role="alert" className="rounded-md border border-accent bg-accent/10 px-3 py-2.5 flex flex-col gap-1.5">
              <div className="text-base text-text font-medium">{pending.name} wants to pair</div>
              <div className="text-sm text-text-muted">
                {pending.online
                  ? 'Accept only if this is your phone and you just scanned the code.'
                  : 'The phone is offline right now. The request lasts until the code’s time runs out.'}
              </div>
              <div className="flex items-center gap-3 pt-0.5">
                <LinkBtn onClick={() => run(() => window.api.mobileAccept(pending.phoneId))}>Accept</LinkBtn>
                <LinkBtn danger onClick={() => run(() => window.api.mobileReject(pending.phoneId))}>Reject</LinkBtn>
              </div>
            </div>
          ) : inviteLive && invite ? (
            <div className="flex gap-3 items-start">
              {qr?.uri === invite.uri && qr.image && (
                <img src={qr.image} alt="Pairing QR code" className="w-40 h-40 rounded-md shrink-0" />
              )}
              <div className="flex flex-col gap-1.5 min-w-0">
                <div className="text-base text-text">
                  {qr?.image ? 'Scan this code with DevTool on your phone.' : 'Open this link with DevTool on your phone.'}
                </div>
                <div className="text-sm text-text-muted">Expires in {formatCountdown(invite.exp, now)} · works once</div>
                {!qr?.image && (
                  <div className="text-xs text-text-subtle font-mono break-all select-text line-clamp-3">{invite.uri}</div>
                )}
                <div className="flex items-center gap-3">
                  <LinkBtn onClick={() => copyLink(invite.uri)}>{copied ? 'Copied' : 'Copy link'}</LinkBtn>
                  <LinkBtn onClick={() => run(() => window.api.mobileStartPairing())}>New code</LinkBtn>
                </div>
              </div>
            </div>
          ) : (
            <SetBlock>
              <div><LinkBtn onClick={() => run(() => window.api.mobileStartPairing())}>
                {invite ? 'Code expired · make a new one' : 'Show pairing code'}
              </LinkBtn></div>
              <HelperText>
                {state.enabled ? 'The code lasts five minutes and pairs one phone.' : 'This also turns on Mobile.'}
              </HelperText>
            </SetBlock>
          )}
        </div>
      </FormGroup>
      {state.incompatible && (
        <HelperText>
          <span className="text-warn">
            {state.incompatible.name}: {updateAdvice(state.incompatible.update)}
          </span>
        </HelperText>
      )}
      {actionError && <HelperText><span className="text-danger">{actionError}</span></HelperText>}

      <GrpHead>Paired phones</GrpHead>
      <Group>
        {state.devices.length === 0 ? (
          <GroupRow label={<span className="text-text-muted">No phones paired yet</span>} />
        ) : (
          state.devices.map(device => (
            <GroupRow
              key={device.id}
              icon={<span className={`w-1.5 h-1.5 rounded-full ${device.online ? 'bg-ssh-connected' : 'bg-status-exited'}`} />}
              label={device.name}
              sub={device.outdated
                ? <span className="text-warn">{updateAdvice(device.outdated)}</span>
                : `${device.online ? 'Online' : formatLastSeen(device.lastSeen, now)}${device.push ? ' · Notifications on' : ''}`}
              trailing={
                <InlineConfirm
                  trigger="Revoke"
                  prompt="Revoke this phone?"
                  confirmLabel="Revoke"
                  onConfirm={() => run(() => window.api.mobileRevoke(device.id))}
                />
              }
            />
          ))
        )}
      </Group>
    </>
  )
}

import React, { useCallback, useEffect, useState } from 'react'
import type { MobilePairingInvite, MobileState } from '../../../shared/mobile'
import { formatCountdown, formatLastSeen } from '../../hooks/useMobileState'
import { renderPairingQr } from '../settings/pairingQr'
import { InlineConfirm, LinkBtn } from '../ui'
import { stripBidi } from '../../../shared/printable'

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, '')
}

export interface ServerPhones {
  /** The server's phone state; the last one seen while it is offline, null before any. */
  state: MobileState | null
  /** Whether the Pair a phone panel is open (opened here, or a phone is asking). */
  panelOpen: boolean
  busy: boolean
  error: string | null
  /** A line to show after something finished ("Paired with …"). */
  notice: string | null
  start(): void
  cancel(): void
  accept(phoneId: string): void
  reject(phoneId: string): void
  revoke(phoneId: string): void
}

/**
 * A server's phones (plan step 10): its MobileState, loaded when the server is
 * online and kept current by `server-mobile-state-changed` pushes for this
 * server only, plus the actions of Settings › Servers › Pair a phone.
 */
export function useServerPhones(serverId: string, online: boolean): ServerPhones {
  const [state, setState] = useState<MobileState | null>(null)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** The request on screen last render, to say what became of it once it is gone. */
  const [shownRequest, setShownRequest] = useState<{ phoneId: string; name: string } | null>(null)
  /** The phone a click here rejected. */
  const [rejectedId, setRejectedId] = useState<string | null>(null)

  useEffect(() => {
    return window.api.onServerMobileStateChanged((from, next) => {
      if (from === serverId) setState(next)
    })
  }, [serverId])

  useEffect(() => {
    if (!online) return
    let alive = true
    void window.api.serverMobileGetState(serverId)
      .then(next => { if (alive) setState(next) })
      .catch(() => {})
    return () => { alive = false }
  }, [serverId, online])

  // A request that went away (accepted here, in the server's terminal, rejected,
  // or run out) closes the panel in the same render, with a line saying how it ended.
  const request = state?.pending ? { phoneId: state.pending.phoneId, name: stripBidi(state.pending.name) } : null
  if (state && (request?.phoneId ?? null) !== (shownRequest?.phoneId ?? null)) {
    setShownRequest(request)
    if (!request && shownRequest) {
      setOpened(false)
      setNotice(state.devices.some(d => d.id === shownRequest.phoneId)
        ? `Paired with ${shownRequest.name}.`
        : rejectedId === shownRequest.phoneId ? `Rejected ${shownRequest.name}.` : `${shownRequest.name} did not pair.`)
    }
  }

  const run = useCallback((action: () => Promise<MobileState | MobilePairingInvite>) => {
    setBusy(true)
    setError(null)
    action()
      .then(result => {
        if ('connection' in result) setState(result)
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false))
  }, [])

  return {
    state,
    panelOpen: opened || !!state?.pending,
    busy,
    error,
    notice,
    start: () => {
      setNotice(null)
      setOpened(true)
      // The pushed state carries the invite; ask too, in case the push is slower than the answer.
      run(async () => {
        await window.api.serverMobileStartPairing(serverId)
        return window.api.serverMobileGetState(serverId)
      })
    },
    cancel: () => {
      setOpened(false)
      run(() => window.api.serverMobileCancelPairing(serverId))
    },
    accept: (phoneId) => run(() => window.api.serverMobileAccept(serverId, phoneId)),
    reject: (phoneId) => {
      setRejectedId(phoneId)
      run(() => window.api.serverMobileReject(serverId, phoneId))
    },
    revoke: (phoneId) => run(() => window.api.serverMobileRevoke(serverId, phoneId))
  }
}

/**
 * The Pair a phone panel under a server's row: the server's QR code with its
 * expiry and Copy link, then the phone's request with Accept and Reject. The
 * same presentation as Settings › Mobile, for a phone that pairs with the server.
 */
export function PhonePairingPanel({ serverName, online, phones, now }: {
  serverName: string
  online: boolean
  phones: ServerPhones
  now: number
}): React.ReactElement | null {
  const [qr, setQr] = useState<{ uri: string; image: string | null } | null>(null)
  const [copied, setCopied] = useState(false)
  const invite = phones.state?.invite ?? null
  const pending = phones.state?.pending ?? null
  const inviteUri = invite?.uri ?? null

  useEffect(() => {
    if (!inviteUri) { setQr(null); return }
    let alive = true
    void renderPairingQr(inviteUri)
      .then(image => { if (alive) setQr({ uri: inviteUri, image }) })
      .catch(() => { if (alive) setQr({ uri: inviteUri, image: null }) })
    return () => { alive = false }
  }, [inviteUri])

  if (!phones.panelOpen) return null
  const inviteLive = !!invite && invite.exp * 1000 > now

  const copyLink = (uri: string) => {
    void navigator.clipboard.writeText(uri).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <div className="ml-3.5 mt-1 rounded-md border border-border bg-surface-2 px-2.5 py-2 flex flex-col gap-1.5" data-testid="phone-pairing">
      {pending ? (
        <div role="alert" className="flex flex-col gap-1.5">
          {/* A phone picks its own name: no bidi controls that could reorder the line. */}
          <div className="text-base text-text font-medium">{stripBidi(pending.name)} wants to pair with {stripBidi(serverName)}</div>
          <div className="text-sm text-text-muted">
            {pending.online
              ? 'Accept only if this is your phone and you just scanned the code.'
              : 'The phone is offline right now. The request lasts until the code’s time runs out.'}
          </div>
          <div className="flex items-center gap-3 pt-0.5">
            <LinkBtn disabled={!online || phones.busy} onClick={() => phones.accept(pending.phoneId)}>Accept</LinkBtn>
            <LinkBtn danger disabled={!online || phones.busy} onClick={() => phones.reject(pending.phoneId)}>Reject</LinkBtn>
          </div>
        </div>
      ) : inviteLive && invite ? (
        <div className="flex gap-3 items-start">
          {qr?.uri === invite.uri && qr.image && (
            <img src={qr.image} alt="Pairing QR code" className="w-40 h-40 rounded-md shrink-0" />
          )}
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="text-sm text-text">
              {qr?.image ? `Scan this code with DevTool on your phone. The phone pairs with ${serverName}.` : `Open this link with DevTool on your phone. The phone pairs with ${serverName}.`}
            </div>
            <div className="text-sm text-text-muted">Expires in {formatCountdown(invite.exp, now)} · works once</div>
            {!qr?.image && (
              <div className="text-xs text-text-subtle font-mono break-all select-text line-clamp-3">{invite.uri}</div>
            )}
            <div className="flex items-center gap-3">
              <LinkBtn onClick={() => copyLink(invite.uri)}>{copied ? 'Copied' : 'Copy link'}</LinkBtn>
              <LinkBtn disabled={!online || phones.busy} onClick={phones.start}>New code</LinkBtn>
              <LinkBtn onClick={phones.cancel}>Cancel</LinkBtn>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-sm text-text-muted">
          <span>
            {phones.busy && !invite
              ? 'Asking the server for a code…'
              : invite
                ? 'The code expired.'
                : 'This code no longer works: another pairing code on the server took its place.'}
          </span>
          {!phones.busy && <LinkBtn disabled={!online} onClick={phones.start}>New code</LinkBtn>}
          {!phones.busy && <span className="ml-auto"><LinkBtn onClick={phones.cancel}>Hide</LinkBtn></span>}
        </div>
      )}
    </div>
  )
}

/** The phones paired with a server, each with Revoke. */
export function PairedPhones({ online, phones, now }: { online: boolean; phones: ServerPhones; now: number }): React.ReactElement | null {
  const devices = phones.state?.devices ?? []
  if (devices.length === 0) return null
  return (
    <div className="pl-3.5 flex flex-col gap-0.5" data-testid="server-phones">
      {devices.map(device => (
        <div key={device.id} className="flex items-center gap-2 text-sm text-text-muted min-w-0" data-testid="server-phone">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${device.online ? 'bg-ssh-connected' : 'bg-status-exited'}`} />
          <span className="text-text truncate">{stripBidi(device.name)}</span>
          <span className="truncate">
            {device.outdated
              ? (device.outdated === 'phone' ? 'Update DevTool on this phone' : 'Needs a newer server')
              : `${device.online ? 'Online' : formatLastSeen(device.lastSeen, now)}${device.push ? ' · Notifications on' : ''}`}
          </span>
          {online && (
            <span className="ml-auto shrink-0">
              <InlineConfirm trigger="Revoke" prompt="Revoke this phone?" confirmLabel="Revoke" onConfirm={() => phones.revoke(device.id)} />
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

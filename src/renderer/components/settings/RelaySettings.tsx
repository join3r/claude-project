import React, { useState } from 'react'
import { DEFAULT_MOBILE_RELAY_URL, isUnencryptedRemoteRelay, isValidRelayUrl, normalizeRelayUrl, UNENCRYPTED_RELAY_WARNING } from '../../../shared/mobile'
import { useServersState } from '../../serversState'
import { useMobileState } from '../../hooks/useMobileState'
import { Field, FormGroup, GrpHead, HelperText, LinkBtn, SetBlock } from '../ui'
import { RELAY_DOT, pairedOnRelay, relayStatus } from './relay'

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (\w+Error: )?/, '')
}

/**
 * Settings › Relay: the one relay this desktop's phones and servers reach it
 * through. Stored as Mobile's `relayUrl`, which the servers follow too.
 * Changing it with anything paired asks first: phones and servers keep using
 * the relay they paired on, so they go offline until they're paired again.
 */
export default function RelaySettings(): React.ReactElement {
  const [mobile, setMobile] = useMobileState()
  const servers = useServersState()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!mobile) return <div />

  const current = mobile.relayUrl
  const shown = draft ?? current
  const candidate = normalizeRelayUrl(shown)
  const changed = draft !== null && candidate !== current
  const paired = pairedOnRelay(servers.servers.length, mobile.devices.length)
  const status = relayStatus(mobile, servers)

  const save = (url: string): void => {
    setError(null)
    void window.api.mobileSetRelayUrl(url)
      .then((next) => { setMobile(next); setDraft(null) })
      .catch((err: unknown) => setError(errorMessage(err)))
  }

  /** Enter or leaving the field: saves at once when nothing is paired; otherwise the warning below waits for a click. */
  const commit = (): void => {
    if (!changed) { setDraft(null); setError(null); return }
    if (!isValidRelayUrl(candidate)) { setError('Use a ws:// or wss:// address.'); return }
    if (!paired) save(candidate)
  }

  return (
    <>
      <GrpHead>Relay</GrpHead>
      <FormGroup>
        <SetBlock label="Relay address">
          <Field
            value={shown}
            onChange={(e) => { setDraft(e.target.value); setError(null) }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') { setDraft(null); setError(null) }
            }}
            spellCheck={false}
            placeholder="wss://relay.example.com"
            aria-label="Relay address"
          />
          <div className="flex items-center gap-1.5 text-sm text-text-muted" data-testid="relay-status">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${RELAY_DOT[status.tone]}`} />
            {status.text}
          </div>
          {error && <HelperText><span className="text-danger">{error}</span></HelperText>}
          {!error && isUnencryptedRemoteRelay(shown) && (
            <HelperText><span className="text-warn">{UNENCRYPTED_RELAY_WARNING}</span></HelperText>
          )}
        </SetBlock>
        {changed && paired && isValidRelayUrl(candidate) && (
          <div role="alert" className="rounded-md border border-warn/60 bg-warn/10 px-3 py-2.5 flex flex-col gap-1.5" data-testid="relay-change-warning">
            <div className="text-base text-text">Change the relay for {paired}?</div>
            <div className="text-sm text-text-muted">
              They have to reach the same relay as this computer. After the change they go offline until you pair them again on the new relay.
            </div>
            <div className="flex items-center gap-3 pt-0.5">
              <LinkBtn danger onClick={() => save(candidate)}>Change relay</LinkBtn>
              <LinkBtn onClick={() => { setDraft(null); setError(null) }}>Keep the current one</LinkBtn>
            </div>
          </div>
        )}
      </FormGroup>
      <HelperText>
        Phones and DevTool servers reach this computer through the relay. It passes along end-to-end encrypted traffic and never sees its contents.
      </HelperText>
      {current !== DEFAULT_MOBILE_RELAY_URL && !changed && (
        <div><LinkBtn onClick={() => { setDraft(DEFAULT_MOBILE_RELAY_URL); setError(null) }}>Use the default relay</LinkBtn></div>
      )}
    </>
  )
}

/** One line on the Mobile and Servers pages: which relay, its state, and a way to Settings › Relay. */
export function RelayLine({ onOpenRelay }: { onOpenRelay: () => void }): React.ReactElement | null {
  const [mobile] = useMobileState()
  const servers = useServersState()
  if (!mobile) return null
  const status = relayStatus(mobile, servers)
  return (
    <div className="flex flex-col gap-1 px-1" data-testid="relay-line">
      <div className="flex items-center gap-1.5 text-sm text-text-muted min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${RELAY_DOT[status.tone]}`} />
        <span className="truncate min-w-0">
          Relay <span className="font-mono text-xs">{mobile.relayUrl}</span>{status.tone === 'idle' ? '' : `, ${status.text.charAt(0).toLowerCase()}${status.text.slice(1)}`}
        </span>
        <span className="shrink-0 ml-1"><LinkBtn onClick={onOpenRelay}>Change</LinkBtn></span>
      </div>
      {isUnencryptedRemoteRelay(mobile.relayUrl) && <HelperText><span className="text-warn">{UNENCRYPTED_RELAY_WARNING}</span></HelperText>}
    </div>
  )
}

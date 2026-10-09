import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useServersState } from '../../serversState'
import { formatCountdown, useMobileState, useNow } from '../../hooks/useMobileState'
import { HelperText, LinkBtn, Modal, PrimaryButton } from '../ui'
import InstallStatus from './InstallStatus'
import ServerRepoDiscovery from './ServerRepoDiscovery'
import { STALL_MS, canStall, installProgress, pairedServerId, phaseText } from './addServerFlow'

type View = 'command' | 'code'

export interface AddServerDialogProps {
  /** Folders that already are projects on a server. */
  existingDirectories: (serverId: string) => ReadonlySet<string>
  onAddProjects: (serverId: string, projects: Array<{ name: string; directory: string }>) => void
  /** "Choose a folder…": Add server project's folder browser, on this server. */
  onChooseFolder: (serverId: string) => void
  onClose: () => void
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, '')
}

/**
 * Add server: one command to paste on the server, then a live status line until
 * the new server is connected, then a short "Set up" step that adds its
 * repositories as projects. Also pairs with a code from `devtool-server pair`.
 * Closing it cancels the invite.
 */
export default function AddServerDialog({ existingDirectories, onAddProjects, onChooseFolder, onClose }: AddServerDialogProps): React.ReactElement {
  const state = useServersState()
  const [mobile] = useMobileState()
  const [view, setView] = useState<View>('command')
  const [serverId, setServerId] = useState<string | null>(null)
  const [inviteExpiresAt, setInviteExpiresAt] = useState<number | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [added, setAdded] = useState(0)
  const now = useNow(true)

  const newInvite = (): void => {
    setInviteError(null)
    window.api.serversCreateInvite()
      .then((invite) => setInviteExpiresAt(invite.expiresAt))
      .catch((err: unknown) => setInviteError(errorText(err)))
  }

  // One invite while the dialog is open; closing it cancels the invite (and its relay offer).
  useEffect(() => {
    newInvite()
    return () => { void window.api.serversCancelInvite().catch(() => {}) }
  }, [])

  // Follow the invite to the server it paired with; it sticks once known.
  const followed = pairedServerId(serverId, state)
  useEffect(() => {
    if (followed && followed !== serverId) setServerId(followed)
  }, [followed, serverId])

  // The invite on screen: main's, which another window or Install over SSH may have replaced.
  const invite = state.invite
  const waitingUntil = invite?.status === 'waiting' ? invite.expiresAt : null
  useEffect(() => {
    if (waitingUntil !== null) setInviteExpiresAt(waitingUntil)
  }, [waitingUntil])

  const progress = installProgress({ state, serverId: followed, inviteExpiresAt, now })
  const phaseSince = useRef({ phase: progress.phase, at: now })
  if (phaseSince.current.phase !== progress.phase) phaseSince.current = { phase: progress.phase, at: now }
  const stalled = canStall(progress.phase) && now - phaseSince.current.at > STALL_MS

  const connected = progress.phase === 'connected' && !!progress.server
  const text = phaseText(progress, { url: mobile?.relayUrl, error: state.relay.error })
  let detail: React.ReactNode = text.detail
  if (stalled) {
    detail = progress.phase === 'waiting'
      ? "Nothing has connected yet. If the command ran, check the server's terminal for details."
      : "This is taking a while. Check the server's terminal for details."
  }
  const status = <InstallStatus progress={progress} title={text.title} detail={detail} />

  const liveInvite = invite && invite.status === 'waiting' && invite.expiresAt > now ? invite : null
  const copy = (): void => {
    if (!invite) return
    void navigator.clipboard.writeText(invite.oneLiner).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  const connectedId = connected ? progress.server?.id ?? null : null
  const existing = useMemo(
    () => (connectedId ? existingDirectories(connectedId) : new Set<string>()),
    [connectedId, existingDirectories]
  )

  if (connected && progress.server) {
    const server = progress.server
    return (
      <Modal title={`Set up ${server.name}`} onClose={onClose} width="w-[560px]" footer={<PrimaryButton onClick={onClose}>Done</PrimaryButton>}>
        {status}
        <div className="text-base text-text pt-1">Add its git repositories as projects, or choose any folder on it.</div>
        <ServerRepoDiscovery
          serverId={server.id}
          existingDirectories={existing}
          onAdd={(repos) => {
            onAddProjects(server.id, repos)
            setAdded(n => n + repos.length)
          }}
          secondary={<span className="mr-auto"><LinkBtn onClick={() => onChooseFolder(server.id)}>Choose a folder…</LinkBtn></span>}
        />
        {added > 0 && <HelperText>Added {added === 1 ? 'one project' : `${added} projects`} to the sidebar.</HelperText>}
      </Modal>
    )
  }

  const paired = !!followed
  const footer = (
    <>
      <span className="mr-auto flex items-center gap-3">
        {view !== 'command' && <LinkBtn onClick={() => setView('command')}>Back to the command</LinkBtn>}
        {view !== 'code' && !paired && <LinkBtn onClick={() => setView('code')}>I have a code</LinkBtn>}
      </span>
      <LinkBtn onClick={onClose}>Cancel</LinkBtn>
    </>
  )

  return (
    <Modal title="Add server" onClose={onClose} width="w-[560px]" footer={footer}>
      {view === 'code' && !paired ? (
        <CodeForm onPaired={(id) => { setServerId(id); setView('command') }} />
      ) : (
        <>
          {!paired && (
            <div className="flex flex-col gap-2">
              <div className="text-base text-text">Run this command in a terminal on the server.</div>
              <div
                className={`rounded-md border border-border bg-field px-3 py-2.5 font-mono text-sm leading-relaxed text-text break-all select-all ${liveInvite ? '' : 'opacity-45'}`}
                data-testid="install-command"
              >
                {invite?.oneLiner ?? (inviteError ? '' : 'Making a command…')}
              </div>
              <div className="flex items-center gap-3 pt-0.5">
                {liveInvite ? (
                  <>
                    <PrimaryButton onClick={copy}>
                      <span className="flex items-center gap-1.5">
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                        {copied ? 'Copied' : 'Copy command'}
                      </span>
                    </PrimaryButton>
                    <span className="text-sm text-text-muted" data-testid="install-expiry">
                      Works once · expires in {formatCountdown(liveInvite.expiresAt / 1000, now)}
                    </span>
                  </>
                ) : (progress.phase === 'expired' || progress.phase === 'lost' || inviteError) ? (
                  <PrimaryButton onClick={newInvite}>New command</PrimaryButton>
                ) : null}
              </div>
              {inviteError && <HelperText><span className="text-danger">{inviteError}</span></HelperText>}
            </div>
          )}
          <div className={paired ? '' : 'pt-2'}>{status}</div>
        </>
      )}
    </Modal>
  )
}

/** "I have a code": the code `devtool-server pair` (or the installer without a token) printed on the server. */
function CodeForm({ onPaired }: { onPaired: (serverId: string) => void }): React.ReactElement {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pair = (): void => {
    const text = code.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    window.api.serversPairCode(text)
      .then((server) => onPaired(server.id))
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="flex flex-col gap-2" data-testid="pair-code">
      <div className="text-base text-text">Paste the pairing code from the server.</div>
      <textarea
        className="min-h-[76px] px-2.5 py-2 rounded-md bg-field border border-border text-sm font-mono text-text outline-none focus:border-border-focus focus:shadow-focus placeholder:text-text-subtle resize-none break-all"
        value={code}
        onChange={(e) => { setCode(e.target.value); setError(null) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pair() } }}
        placeholder="The code devtool-server pair printed"
        spellCheck={false}
        autoFocus
        disabled={busy}
        aria-label="Pairing code"
      />
      <HelperText>
        On a server that runs DevTool, run <span className="font-mono">devtool-server pair</span>. The installer prints a code too when it runs without a token.
      </HelperText>
      {error && <HelperText><span className="text-danger">{error}</span></HelperText>}
      <div className="flex justify-end pt-1">
        <PrimaryButton onClick={pair} disabled={!code.trim() || busy}>{busy ? 'Pairing…' : 'Pair'}</PrimaryButton>
      </div>
    </div>
  )
}

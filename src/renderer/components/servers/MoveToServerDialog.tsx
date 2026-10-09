import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { matchServerForSsh, sshInstallTargetOf, type ServerMatch } from '../../../shared/project-move'
import type { SshHostProbeResult } from '../../../shared/servers'
import type { Project } from '../../../shared/types'
import { useServersState } from '../../serversState'
import { useMobileState, useNow } from '../../hooks/useMobileState'
import { HelperText, LinkBtn, Modal, PrimaryButton } from '../ui'
import InstallStatus from './InstallStatus'
import { describePlatform, installProgress, pairedServerId, phaseText } from './addServerFlow'
import { askReason, initialChoice, moveSummary, otherRelayText, sshHostLabel, type MoveChoice } from './moveToServerFlow'
import { sshExitNote } from './SshInstallPanel'
import { useSshInstallTerminal } from './useSshInstallTerminal'

type Stage = 'confirm' | 'install' | 'waiting' | 'moving' | 'done'

/** How long the installer may keep its ssh open after the server connected, before the move goes ahead. */
const INSTALL_EXIT_GRACE_MS = 15_000

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, '')
}

/**
 * Move to a DevTool server: an SSH project becomes a project of the DevTool
 * server on the same machine. The dialog checks the host for a server (one
 * already paired is reused), installs over SSH when there is none, waits until
 * the server is online, then has main move the project with all its ids.
 *
 * `project` is the SSH project as it was when the dialog opened: once moved it
 * has no `ssh` any more.
 */
export default function MoveToServerDialog({ project, onClose }: { project: Project; onClose: () => void }): React.ReactElement {
  const state = useServersState()
  const [mobile] = useMobileState()
  const host = sshHostLabel(project)
  const ssh = project.ssh!
  const [probe, setProbe] = useState<SshHostProbeResult | null>(null)
  const [socks, setSocks] = useState(false)
  const [choice, setChoice] = useState<MoveChoice | null>(null)
  const [stage, setStage] = useState<Stage>('confirm')
  const [error, setError] = useState<string | null>(null)
  const [installServerId, setInstallServerId] = useState<string | null>(null)
  const [inviteExpiresAt, setInviteExpiresAt] = useState<number | null>(null)
  const [inviteReady, setInviteReady] = useState(false)
  const [targetServerId, setTargetServerId] = useState<string | null>(null)
  const startedInvite = useRef(false)
  const moveStarted = useRef(false)
  const terminal = useSshInstallTerminal()
  const now = useNow(stage === 'install' || stage === 'waiting')

  // What runs on the host: once, when the dialog opens.
  useEffect(() => {
    let alive = true
    window.api.serversSshProbe(project.id)
      .then((result) => { if (alive) setProbe(result) })
      .catch((err: unknown) => { if (alive) setProbe({ ok: false, error: errorText(err) }) })
    window.api.socksProxyStatus(project.id)
      .then((status) => { if (alive) setSocks(!!status.enabled) })
      .catch(() => {})
    return () => { alive = false }
  }, [project.id])

  // An invite this dialog made goes when it closes.
  useEffect(() => () => {
    if (startedInvite.current) void window.api.serversCancelInvite().catch(() => {})
  }, [])

  const relayUrl = mobile?.relayUrl ?? ''
  const match: ServerMatch | null = useMemo(() => {
    if (!probe || !mobile) return null
    return matchServerForSsh({ ssh, servers: state.servers, probe: probe.ok ? probe.probe : null, relayUrl })
  }, [probe, mobile, ssh, state.servers, relayUrl])

  // The choice follows the check until the user picks.
  const picked = useRef(false)
  useEffect(() => {
    if (!picked.current) setChoice(initialChoice(match))
  }, [match])

  const serverOf = (id: string | null) => (id ? state.servers.find(s => s.id === id) ?? null : null)
  const chosenServer = choice?.kind === 'server' ? serverOf(choice.serverId) : null

  // Install: follow the invite to the server it paired, as Add server does.
  const followed = stage === 'install' ? pairedServerId(installServerId, state) : installServerId
  useEffect(() => {
    if (followed && followed !== installServerId) setInstallServerId(followed)
  }, [followed, installServerId])
  const waitingUntil = state.invite?.status === 'waiting' ? state.invite.expiresAt : null
  useEffect(() => {
    if (stage === 'install' && waitingUntil !== null) setInviteExpiresAt(waitingUntil)
  }, [stage, waitingUntil])
  const progress = installProgress({ state, serverId: followed, inviteExpiresAt, now })
  const installed = stage === 'install' && progress.phase === 'connected' && !!progress.server

  const move = (serverId: string): void => {
    if (moveStarted.current) return
    moveStarted.current = true
    setTargetServerId(serverId)
    setStage('moving')
    setError(null)
    window.api.serversMoveProject(project.id, serverId)
      .then(() => setStage('done'))
      .catch((err: unknown) => {
        moveStarted.current = false
        setError(errorText(err))
        setStage('waiting')
      })
  }

  // Installed: the move goes ahead once the installer's ssh is done (it may share the project's connection, which the move closes).
  useEffect(() => {
    if (!installed || !progress.server) return
    const serverId = progress.server.id
    if (!terminal.session) {
      move(serverId)
      return
    }
    const timer = setTimeout(() => {
      terminal.stop()
      move(serverId)
    }, INSTALL_EXIT_GRACE_MS)
    return () => clearTimeout(timer)
  }, [installed, progress.server?.id, terminal.session])

  // A paired server: the move goes ahead once it is online.
  const target = serverOf(targetServerId)
  useEffect(() => {
    if (stage !== 'waiting' || !target || error) return
    if (target.state === 'online' && !target.installing) move(target.id)
  }, [stage, target?.state, target?.installing, error])

  const start = (): void => {
    if (!choice) return
    setError(null)
    if (choice.kind === 'server') {
      setTargetServerId(choice.serverId)
      setStage('waiting')
      return
    }
    setStage('install')
    startedInvite.current = true
    window.api.serversCreateInvite()
      .then((invite) => {
        setInviteExpiresAt(invite.expiresAt)
        setInviteReady(true)
      })
      .catch((err: unknown) => {
        setError(errorText(err))
        setStage('confirm')
      })
  }

  // ssh starts once the relay is up and holds the invite's offer: the installer
  // can be quick (Node already there, the project's connection reused), and a
  // pairing that reaches the relay before the offer is refused.
  const relayOnline = state.relay.kind === 'online'
  const sshStarted = useRef(false)
  useEffect(() => {
    if (stage !== 'install' || !inviteReady || !relayOnline || sshStarted.current) return
    sshStarted.current = true
    terminal.start({ target: sshInstallTargetOf(ssh), projectId: project.id })
  }, [stage, inviteReady, relayOnline])

  const busy = stage === 'moving'
  const close = busy ? () => {} : onClose
  const title = stage === 'done' ? `Moved ${project.name}` : `Move ${project.name} to a DevTool server`

  if (stage === 'done') {
    const server = serverOf(targetServerId)
    return (
      <Modal title={title} onClose={onClose} width="w-[560px]" footer={<PrimaryButton onClick={onClose}>Done</PrimaryButton>}>
        <div className="flex items-start gap-2" role="status" data-testid="move-done">
          <Check size={15} className="text-success shrink-0 mt-0.5" aria-hidden />
          <div className="text-base text-text">
            {project.name} is on {server?.name ?? 'the server'} now. Its terminals and agents restart there.
          </div>
        </div>
      </Modal>
    )
  }

  const installing = stage === 'install'
  const text = phaseText(progress, { url: relayUrl, error: state.relay.error })
  const note = terminal.ended ? sshExitNote(terminal.ended.exit, terminal.ended.target, installed) : null
  const footer = (
    <>
      <LinkBtn onClick={close} disabled={busy}>Cancel</LinkBtn>
      {stage === 'confirm' && (
        <PrimaryButton onClick={start} disabled={!choice || !match}>
          {choice?.kind === 'install' ? 'Install and move' : 'Move'}
        </PrimaryButton>
      )}
      {installing && !terminal.session && terminal.ended && !installed && (
        <PrimaryButton onClick={() => terminal.start({ target: sshInstallTargetOf(ssh), projectId: project.id })}>Try again</PrimaryButton>
      )}
      {stage === 'waiting' && error && targetServerId && (
        <PrimaryButton onClick={() => { setError(null); moveStarted.current = false }}>Try again</PrimaryButton>
      )}
    </>
  )

  return (
    <Modal title={title} onClose={close} width="w-[560px]" footer={footer}>
      {stage === 'confirm' && (
        <>
          <ul className="m-0 pl-4 flex flex-col gap-1 text-base text-text list-disc" data-testid="move-summary">
            {moveSummary({ host, choice, server: chosenServer, tunnel: !!project.tunnel, socks }).map(line => <li key={line}>{line}</li>)}
          </ul>
          <ServerCheck
            host={host}
            probe={probe}
            match={match}
            choice={choice}
            relayUrl={relayUrl}
            servers={state.servers}
            onPick={(next) => { picked.current = true; setChoice(next) }}
          />
        </>
      )}
      {installing && (
        <div className="flex flex-col gap-3" data-testid="move-install">
          <div className="text-base text-text">Installing DevTool on {host} over SSH. Answer any questions in the terminal.</div>
          <div
            className="h-[200px] rounded-md border border-border overflow-hidden px-2 py-1.5"
            style={{ background: terminal.theme.background }}
            data-testid="ssh-install-terminal"
          >
            <div ref={terminal.hostRef} className="w-full h-full" />
          </div>
          {note && <HelperText><span className={terminal.ended?.exit.reason === 'stopped' ? '' : 'text-danger'}>{note}</span></HelperText>}
          <InstallStatus progress={progress} title={installed ? `Connected to ${progress.server?.host?.hostname || progress.server?.name}. Moving next…` : text.title} detail={text.detail} />
        </div>
      )}
      {(stage === 'waiting' || stage === 'moving') && target && (
        <div className="flex items-start gap-2" role="status" data-testid="move-progress">
          <span className={`mt-[7px] w-1.5 h-1.5 rounded-full shrink-0 ${error ? 'bg-danger' : 'bg-accent status-pulse'}`} />
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="text-base text-text">
              {error ? `${project.name} did not move.`
                : stage === 'moving' ? `Moving ${project.name} to ${target.name}…`
                  : target.state === 'online' ? `Connecting to ${target.name}…` : `Waiting for ${target.name} to come online…`}
            </div>
            {target.host && <div className="text-sm text-text-muted">{[target.host.hostname, describePlatform(target.host)].filter(Boolean).join(', ')}</div>}
          </div>
        </div>
      )}
      {error && <HelperText><span className="text-danger" data-testid="move-error">{error}</span></HelperText>}
    </Modal>
  )
}

/** What the host check found, and the server to move to when DevTool has to ask. */
function ServerCheck({ host, probe, match, choice, relayUrl, servers, onPick }: {
  host: string
  probe: SshHostProbeResult | null
  match: ServerMatch | null
  choice: MoveChoice | null
  relayUrl: string
  servers: ReturnType<typeof useServersState>['servers']
  onPick: (choice: MoveChoice) => void
}): React.ReactElement | null {
  if (!match) {
    return <div className="text-sm text-text-muted flex items-center gap-2" data-testid="move-checking"><span className="w-1.5 h-1.5 rounded-full bg-accent status-pulse" />Checking {host} for a DevTool server…</div>
  }
  if (match.kind === 'other-relay') {
    return <HelperText><span className="text-danger" data-testid="move-other-relay">{otherRelayText(host, match.relayUrl, relayUrl)}</span></HelperText>
  }
  if (match.kind !== 'ask') return null
  const options: Array<{ choice: MoveChoice; label: string; detail: string }> = [
    ...match.candidates.flatMap((id) => {
      const server = servers.find(s => s.id === id)
      if (!server) return []
      const where = server.host ? [server.host.user ? `${server.host.user}@${server.host.hostname}` : server.host.hostname, describePlatform(server.host)].filter(Boolean).join(', ') : ''
      return [{ choice: { kind: 'server', serverId: id } as MoveChoice, label: server.name, detail: [where, server.state === 'online' ? 'online' : server.state].filter(Boolean).join(' · ') }]
    }),
    { choice: { kind: 'install' }, label: `Install DevTool on ${host}`, detail: 'Over SSH, in a terminal here' }
  ]
  const same = (a: MoveChoice | null, b: MoveChoice) => !!a && a.kind === b.kind && (a.kind === 'install' || (b.kind === 'server' && a.serverId === b.serverId))
  return (
    <div className="flex flex-col gap-2" data-testid="move-ask">
      <div className="text-sm text-text-muted">{askReason(probe && !probe.ok ? probe.error : null)}</div>
      <div className="flex flex-col rounded-lg border border-border overflow-hidden" role="radiogroup" aria-label="Where the project goes">
        {options.map((option) => (
          <button
            key={option.choice.kind === 'server' ? option.choice.serverId : 'install'}
            type="button"
            role="radio"
            aria-checked={same(choice, option.choice)}
            onClick={() => onPick(option.choice)}
            className={`flex items-center gap-2.5 px-3 py-2 text-left border-0 border-b border-hair last:border-b-0 cursor-pointer ${same(choice, option.choice) ? 'bg-sel' : 'bg-transparent hover:bg-field'}`}
          >
            <span className={`w-3 h-3 rounded-full border shrink-0 ${same(choice, option.choice) ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_var(--color-surface)]' : 'border-border'}`} />
            <span className="flex flex-col min-w-0">
              <span className="text-base text-text truncate">{option.label}</span>
              {option.detail && <span className="text-sm text-text-muted truncate">{option.detail}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

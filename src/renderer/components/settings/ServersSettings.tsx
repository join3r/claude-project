import React, { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import type { ServerDeviceCode, ServerStatus, ServerUpdateResult } from '../../../shared/servers'
import { useServersState } from '../../serversState'
import { formatCountdown, formatLastSeen, useNow } from '../../hooks/useMobileState'
import { paletteEvents } from '../../palette/paletteEvents'
import { showToast } from '../../toasts'
import { Field, Group, GrpHead, HelperText, LinkBtn } from '../ui'
import { describePlatform } from '../servers/addServerFlow'
import RemoveServerDialog, { OFFLINE_UNINSTALL_COMMAND } from '../servers/RemoveServerDialog'
import { RelayLine } from './RelaySettings'

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, '')
}

type Tone = 'online' | 'busy' | 'offline' | 'bad'

const DOT: Record<Tone, string> = {
  online: 'bg-success',
  busy: 'bg-warn status-pulse',
  offline: 'bg-status-exited',
  bad: 'bg-danger'
}

/** The state as one word or two, and a sentence when there's something to do about it. */
export function serverStateText(server: ServerStatus): { tone: Tone; label: string; note?: string } {
  if (server.problem === 'relay-too-old') return { tone: 'bad', label: 'Relay too old', note: 'This relay is too old for servers. Update it, or pick another relay.' }
  if (server.problem === 'revoked') return { tone: 'bad', label: 'Removed this computer', note: `${server.name} no longer accepts this computer. Remove it here, then add it again.` }
  if (server.problem === 'unknown-device') return { tone: 'bad', label: 'Not paired', note: `${server.name} doesn't know this computer anymore. Remove it, then add it again, or run devtool-server pair on it and use I have a code.` }
  switch (server.state) {
    case 'incompatible':
      return server.update === 'desktop'
        ? { tone: 'bad', label: 'Needs a newer DevTool', note: `${server.name} runs a newer DevTool than this computer. Update DevTool here to use it.` }
        : { tone: 'bad', label: 'Needs an update', note: `${server.name} runs a DevTool server too old for this computer. Run the install command on it again (Add server).` }
    case 'updating':
      return { tone: 'busy', label: 'Restarting into an update' }
    case 'connecting':
      return { tone: 'busy', label: server.installing ? 'Installing' : 'Connecting' }
    case 'offline':
      return server.installing
        ? { tone: 'busy', label: 'Installing' }
        : { tone: 'offline', label: 'Offline', ...(server.error ? { note: server.error } : {}) }
    case 'online':
      if (server.upload) return { tone: 'busy', label: `Updating ${Math.round((server.upload.sent / Math.max(1, server.upload.total)) * 100)}%` }
      if (server.installing) return { tone: 'busy', label: 'Installing' }
      return { tone: 'online', label: 'Online' }
  }
}

/** `, built 9 Oct, 11:41`: tells two builds of one commit apart. */
function builtLabel(builtAt: string): string {
  const time = Date.parse(builtAt)
  if (Number.isNaN(time)) return ''
  return `, built ${new Date(time).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
}

const UPDATE_RESULT: Record<ServerUpdateResult['reason'], string> = {
  'server-empty': 'Sending DevTool to the server.',
  same: 'Already up to date.',
  'desktop-newer': 'Sending the update.',
  'server-newer': 'The server runs a newer build than this DevTool. Nothing to send.',
  'no-bundle': 'This DevTool carries no server build to send.',
  source: 'The server runs from a source checkout, so DevTool leaves it alone.',
  'unknown-age': "DevTool can't tell which build is newer, so it leaves the server as it is."
}

/**
 * Settings › Servers: the relay line, then every paired server with its state,
 * build and machine, and what can be done with it.
 */
export default function ServersSettings({ onOpenRelay }: { onOpenRelay: () => void }): React.ReactElement {
  const state = useServersState()
  const now = useNow(true)
  const [removing, setRemoving] = useState<ServerStatus | null>(null)

  return (
    <>
      <GrpHead actions={<LinkBtn onClick={() => paletteEvents.emit('open-add-server')}>Add server</LinkBtn>}>Servers</GrpHead>
      <RelayLine onOpenRelay={onOpenRelay} />
      <Group>
        {state.servers.length === 0 ? (
          <div className="px-3 py-3 flex flex-col gap-1" data-testid="servers-empty">
            <div className="text-base text-text">No servers yet</div>
            <div className="text-sm text-text-muted">
              A DevTool server is a Linux or macOS machine that runs your terminals and agents, even while this computer sleeps. Add one with a single command.
            </div>
            <div className="pt-1"><LinkBtn onClick={() => paletteEvents.emit('open-add-server')}>Add server…</LinkBtn></div>
          </div>
        ) : (
          state.servers.map(server => (
            <ServerRow key={server.id} server={server} now={now} onRemove={() => setRemoving(server)} />
          ))
        )}
      </Group>
      {state.servers.length > 0 && (
        <HelperText>Servers keep their terminals and agents running while this computer sleeps. Their projects show in the sidebar with the server's name.</HelperText>
      )}
      {removing && (
        <RemoveServerDialog
          server={state.servers.find(s => s.id === removing.id) ?? removing}
          onClose={() => setRemoving(null)}
          onRemove={async (options) => {
            const result = await window.api.serversRemove(removing.id, options)
            setRemoving(null)
            if (options.uninstall && !result.uninstalled) {
              showToast(`Removed ${removing.name} here, but it could not uninstall itself. Run ${OFFLINE_UNINSTALL_COMMAND} on it.`)
            }
          }}
        />
      )}
    </>
  )
}

function ServerRow({ server, now, onRemove }: { server: ServerStatus; now: number; onRemove: () => void }): React.ReactElement {
  const [renaming, setRenaming] = useState(false)
  const [code, setCode] = useState<ServerDeviceCode | null>(null)
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null)
  const [busy, setBusy] = useState<'code' | 'update' | 'restart' | null>(null)
  const status = serverStateText(server)
  const online = server.state === 'online'
  const build = server.build
  const host = server.host

  const act = (kind: 'code' | 'update' | 'restart', run: () => Promise<void>): void => {
    setBusy(kind)
    setMessage(null)
    run().catch((err: unknown) => setMessage({ text: errorText(err), bad: true })).finally(() => setBusy(null))
  }

  const codeLive = code && code.expiresAt > now

  return (
    <div className="px-3 py-2.5 border-t border-hair first:border-t-0 flex flex-col gap-1" data-testid="server-row" data-server={server.id}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT[status.tone]}`} />
        {renaming ? (
          <RenameField server={server} onDone={() => setRenaming(false)} />
        ) : (
          <button
            type="button"
            className="group flex items-center gap-1.5 min-w-0 bg-transparent border-0 p-0 text-base text-text font-medium cursor-text text-left"
            onClick={() => setRenaming(true)}
            title="Rename"
            aria-label={`Rename ${server.name}`}
          >
            <span className="truncate">{server.name}</span>
            <Pencil size={11} className="shrink-0 text-text-subtle opacity-0 group-hover:opacity-100 transition-opacity duration-(--motion-fast)" />
          </button>
        )}
        <span className="ml-auto text-sm text-text-muted shrink-0" data-testid="server-state">{status.label}</span>
      </div>
      <div className="pl-3.5 flex flex-col gap-0.5 text-sm text-text-muted">
        <div>
          {build?.version ? `DevTool ${build.version}${build.commit ? ` (${build.commit.slice(0, 7)})` : ''}` : 'Not connected yet'}
          {host ? `, ${host.hostname}, ${describePlatform(host)}` : ''}
        </div>
        <div>{online ? `Paired ${new Date(server.pairedAt).toLocaleDateString()}` : formatLastSeen(server.lastSeen, now)}</div>
        {status.note && <div className={status.tone === 'bad' ? 'text-danger' : ''}>{status.note}</div>}
      </div>
      {server.updateReady && (
        <div className="ml-3.5 mt-1 rounded-md border border-accent/50 bg-accent/10 px-2.5 py-2 flex items-center gap-3" data-testid="update-ready">
          <span className="text-sm text-text flex-1 min-w-0">
            Update ready: DevTool {server.updateReady.version}{server.updateReady.commit ? ` (${server.updateReady.commit.slice(0, 7)})` : ''}{builtLabel(server.updateReady.builtAt)}. It switches once no tab is working.
          </span>
          <LinkBtn disabled={busy !== null} onClick={() => act('restart', () => window.api.serversRestart(server.id))}>
            {busy === 'restart' ? 'Restarting…' : 'Restart into update'}
          </LinkBtn>
        </div>
      )}
      {code && (
        <div className="ml-3.5 mt-1 rounded-md border border-border bg-surface-2 px-2.5 py-2 flex flex-col gap-1.5" data-testid="device-code">
          {codeLive ? (
            <>
              <div className="text-sm text-text">In DevTool on the other computer: Add server, I have a code, then paste this.</div>
              <code className="font-mono text-xs text-text break-all select-all leading-relaxed">{code.code}</code>
              <div className="flex items-center gap-3 text-sm text-text-muted">
                <LinkBtn onClick={() => {
                  void navigator.clipboard.writeText(code.code)
                    .then(() => setMessage({ text: 'Copied the code.' }))
                    .catch(() => {})
                }}>Copy</LinkBtn>
                <span>Works once · expires in {formatCountdown(code.expiresAt / 1000, now)}</span>
                <span className="ml-auto"><LinkBtn onClick={() => setCode(null)}>Hide</LinkBtn></span>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3 text-sm text-text-muted">
              <span>The code expired.</span>
              <LinkBtn disabled={!online || busy !== null} onClick={() => act('code', async () => setCode(await window.api.serversDeviceCode(server.id)))}>New code</LinkBtn>
            </div>
          )}
        </div>
      )}
      {message && <div className={`pl-3.5 text-sm ${message.bad ? 'text-danger' : 'text-text-muted'}`}>{message.text}</div>}
      <div className="pl-3.5 pt-1 flex items-center gap-4">
        <LinkBtn
          disabled={!online || busy !== null}
          title={online ? undefined : 'The server has to be online'}
          onClick={() => act('code', async () => setCode(await window.api.serversDeviceCode(server.id)))}
        >{busy === 'code' ? 'Asking the server…' : 'Add another device'}</LinkBtn>
        <LinkBtn
          disabled={!online || busy !== null || !!server.upload}
          title={online ? undefined : 'The server has to be online'}
          onClick={() => act('update', async () => {
            const result = await window.api.serversUpdate(server.id)
            setMessage({ text: UPDATE_RESULT[result.reason] })
          })}
        >{busy === 'update' ? 'Checking…' : 'Update now'}</LinkBtn>
        <span className="ml-auto"><LinkBtn danger onClick={onRemove}>Remove…</LinkBtn></span>
      </div>
    </div>
  )
}

function RenameField({ server, onDone }: { server: ServerStatus; onDone: () => void }): React.ReactElement {
  const [value, setValue] = useState(server.name)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => { ref.current?.select() }, [])

  const save = (): void => {
    if (done.current) return
    const name = value.trim()
    if (!name || name === server.name) { done.current = true; onDone(); return }
    done.current = true
    window.api.serversRename(server.id, name)
      .then(() => onDone())
      .catch((err: unknown) => { done.current = false; setError(errorText(err)) })
  }

  return (
    <span className="flex items-center gap-2 min-w-0 flex-1">
      <Field
        ref={ref}
        className="h-(--ctl-h-sm) text-base flex-1 min-w-0 max-w-[260px]"
        value={value}
        maxLength={100}
        onChange={(e) => { setValue(e.target.value); setError(null) }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') { done.current = true; onDone() }
        }}
        aria-label="Server name"
      />
      {error && <span className="text-xs text-danger truncate">{error}</span>}
    </span>
  )
}

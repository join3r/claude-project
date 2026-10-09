import React, { useState } from 'react'
import type { ServerRemoveOptions, ServerStatus } from '../../../shared/servers'
import { HelperText, LinkBtn, Modal, Switch } from '../ui'

export const OFFLINE_UNINSTALL_COMMAND = 'devtool-server uninstall'

/**
 * Remove a server: this desktop forgets it (and revokes the relay pair). While
 * the server is online it can also uninstall itself, keeping its data or not;
 * an offline one has to be uninstalled on the machine.
 */
export default function RemoveServerDialog({ server, onRemove, onClose }: {
  server: ServerStatus
  onRemove: (options: ServerRemoveOptions) => Promise<void>
  onClose: () => void
}): React.ReactElement {
  const online = server.state === 'online'
  const [uninstall, setUninstall] = useState(online)
  const [keepData, setKeepData] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const remove = (): void => {
    setBusy(true)
    setError(null)
    onRemove(online && uninstall ? { uninstall: true, keepData } : {})
      .catch((err: unknown) => {
        setError((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, ''))
        setBusy(false)
      })
  }

  return (
    <Modal
      title={`Remove ${server.name}?`}
      onClose={busy ? () => {} : onClose}
      width="w-[480px]"
      footer={
        <>
          <LinkBtn onClick={onClose} disabled={busy}>Cancel</LinkBtn>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="inline-flex items-center justify-center h-(--ctl-h) px-4 rounded-md border-0 cursor-pointer text-base font-medium text-white bg-danger shadow-btn hover:brightness-105 active:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? (online && uninstall ? 'Uninstalling…' : 'Removing…') : online && uninstall ? 'Uninstall and remove' : 'Remove'}
          </button>
        </>
      }
    >
      <div className="text-base text-text">
        This computer forgets {server.name} and its projects leave the sidebar.
        {online && uninstall ? '' : ' Other computers paired with it keep using it.'}
      </div>
      {online ? (
        <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-field p-3" data-testid="remove-options">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <Switch checked={uninstall} onChange={setUninstall} />
            <span className="flex flex-col gap-0.5">
              <span className="text-base text-text">Also uninstall DevTool from {server.name}</span>
              <span className="text-sm text-text-muted">Stops its service and removes ~/.devtool-server. Its terminals and agents stop, for every computer paired with it.</span>
            </span>
          </label>
          {uninstall && (
            <label className="flex items-start gap-2.5 cursor-pointer pl-[44px]">
              <Switch checked={keepData} onChange={setKeepData} />
              <span className="flex flex-col gap-0.5">
                <span className="text-base text-text">Keep its data</span>
                <span className="text-sm text-text-muted">Keeps its projects, settings and pairings for a later install.</span>
              </span>
            </label>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-field p-3" data-testid="remove-offline">
          <div className="text-base text-text">{server.name} is offline, so DevTool can't uninstall it from here.</div>
          <div className="text-sm text-text-muted">To remove DevTool from it, run this on the server:</div>
          <div className="flex items-center gap-3">
            <code className="font-mono text-sm text-text select-all">{OFFLINE_UNINSTALL_COMMAND}</code>
            <LinkBtn onClick={() => {
              void navigator.clipboard.writeText(OFFLINE_UNINSTALL_COMMAND).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }).catch(() => {})
            }}>{copied ? 'Copied' : 'Copy'}</LinkBtn>
          </div>
          <div className="text-sm text-text-muted">Remove here takes it off this computer only.</div>
        </div>
      )}
      {error && <HelperText><span className="text-danger">{error}</span></HelperText>}
    </Modal>
  )
}

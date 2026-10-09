import React, { useState } from 'react'
import { ArrowUpCircle, TriangleAlert, X } from 'lucide-react'
import type { ServersState } from '../../../shared/servers'
import { useServersState } from '../../serversState'
import { showToast } from '../../toasts'
import { LinkBtn } from '../ui'

export interface ServerNotice {
  key: string
  serverId: string
  kind: 'update-ready' | 'desktop-too-old' | 'server-too-old'
  text: string
  action: string
}

/** What the sidebar footer has to say about the servers: updates waiting and version gaps. */
export function serverNotices(state: ServersState): ServerNotice[] {
  const notices: ServerNotice[] = []
  for (const server of state.servers) {
    if (server.updateReady) {
      notices.push({
        key: `${server.id}:ready:${server.updateReady.version}:${server.updateReady.commit}`,
        serverId: server.id,
        kind: 'update-ready',
        text: `${server.name} has an update ready`,
        action: 'Restart now'
      })
    } else if (server.state === 'incompatible' && server.update === 'desktop') {
      notices.push({ key: `${server.id}:desktop`, serverId: server.id, kind: 'desktop-too-old', text: `${server.name} needs a newer DevTool`, action: 'Update' })
    } else if (server.state === 'incompatible' && server.update === 'server') {
      notices.push({ key: `${server.id}:server`, serverId: server.id, kind: 'server-too-old', text: `${server.name} needs an update`, action: 'Details' })
    }
  }
  return notices
}

/**
 * Non-blocking notes above the Settings button: "<server> has an update ready ·
 * Restart now" while a staged update waits for its tabs to go idle, and "<server>
 * needs a newer DevTool" when the versions can't talk. Each can be put away until
 * it changes.
 */
export default function ServerNotices({ onOpenSettings }: { onOpenSettings: (tab: string) => void }): React.ReactElement | null {
  const state = useServersState()
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [restarting, setRestarting] = useState<string | null>(null)
  const notices = serverNotices(state).filter(n => !dismissed.has(n.key))
  if (notices.length === 0) return null

  const act = (notice: ServerNotice): void => {
    if (notice.kind === 'desktop-too-old') { onOpenSettings('updates'); return }
    if (notice.kind === 'server-too-old') { onOpenSettings('servers'); return }
    setRestarting(notice.serverId)
    window.api.serversRestart(notice.serverId)
      .catch((err: unknown) => showToast(`Couldn't restart: ${(err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, '')}`))
      .finally(() => setRestarting(null))
  }

  return (
    <div className="flex flex-col gap-1 px-2 pt-1.5 pb-0.5 border-t border-hair [-webkit-app-region:no-drag]" data-testid="server-notices">
      {notices.map(notice => {
        const Icon = notice.kind === 'update-ready' ? ArrowUpCircle : TriangleAlert
        return (
          <div key={notice.key} role="status" className="flex items-start gap-1.5 min-w-0 px-2 py-1.5 rounded-md bg-surface-2">
            <Icon size={12} className={`shrink-0 mt-[3px] ${notice.kind === 'update-ready' ? 'text-accent' : 'text-warn'}`} aria-hidden />
            <div className="flex-1 min-w-0 flex flex-col items-start gap-0.5">
              <span className="text-sm text-text leading-snug break-words min-w-0">{notice.text}</span>
              <LinkBtn disabled={restarting === notice.serverId} onClick={() => act(notice)}>
                {restarting === notice.serverId ? 'Restarting…' : notice.action}
              </LinkBtn>
            </div>
            <button
              type="button"
              onClick={() => setDismissed(prev => new Set(prev).add(notice.key))}
              title="Not now"
              aria-label="Not now"
              className="shrink-0 flex items-center justify-center size-4 rounded-sm bg-transparent border-0 text-text-subtle hover:text-text cursor-pointer"
            ><X size={11} /></button>
          </div>
        )
      })}
    </div>
  )
}

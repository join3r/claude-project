import React, { useMemo } from 'react'
import { X } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { streamRunKey } from '../../../shared/stream-run'
import { dismissStreamRunCrash, openStreamRunLogs, useAllStreamRuns, useDismissedStreamRunCrashes } from '../../streamRuns'
import { useServersState } from '../../serversState'
import { useSshStatuses } from '../../sshStatuses'
import { useMobileState } from '../../hooks/useMobileState'
import { paletteEvents } from '../../palette/paletteEvents'
import { inboxApps, type InboxApp } from '../inbox'
import { openBenchRun } from './benchState'
import { runLogTaskId, statusHosts, statusPhone, statusRunLabel, type StatusTone } from './statusBar'

const DOT: Record<StatusTone, string> = {
  ok: 'bg-running',
  idle: 'bg-text-subtle opacity-60',
  bad: 'bg-crashed',
  needs: 'bg-needs'
}

const ITEM = 'flex items-center gap-1.5 h-full px-2.5 border-r-[0.5px] border-hair text-xs text-text-muted whitespace-nowrap min-w-0'
const BUTTON = `${ITEM} bg-transparent border-y-0 border-l-0 cursor-pointer hover:text-text hover:bg-sel transition-colors duration-(--motion-fast)`

/**
 * A run's log: in the Bench of its task, or of the task this window shows when
 * it is of the same project; else the logs window. The status bar and ⌘K.
 */
export function openRunLog(app: InboxApp, here: {
  selectedProjectId: string | null
  selectedTaskId: string | null
  switchToTask: (projectId: string, taskId: string) => void
}): void {
  const target = { projectId: app.project.id, streamId: app.stream.id, commandId: app.run.commandId }
  const taskId = runLogTaskId(app, { projectId: here.selectedProjectId, taskId: here.selectedTaskId })
  if (!taskId) {
    openStreamRunLogs(target)
    return
  }
  if (taskId !== here.selectedTaskId) here.switchToTask(app.project.id, taskId)
  openBenchRun(taskId, target)
}

/**
 * The desk's status bar, along the bottom of the window (change 7 of the
 * redesign): host health on the left; the stream commands that run or crashed
 * and the phone on the right. A run opens its log in the Bench of its task (or
 * of the task this window shows, in the same project), else as the logs
 * window. A host or the phone opens its Settings page.
 */
export default function DeskStatusBar(): React.ReactElement {
  const { projects, selectedProjectId, selectedTaskId, switchToTask } = useApp()
  const projectIds = useMemo(() => projects.map(project => project.id), [projects])
  const sshProjectIds = useMemo(() => projects.filter(project => project.ssh).map(project => project.id), [projects])
  const servers = useServersState()
  const ssh = useSshStatuses(sshProjectIds)
  const runs = useAllStreamRuns(projectIds)
  const dismissed = useDismissedStreamRunCrashes()
  const [mobile] = useMobileState()

  const hosts = useMemo(() => statusHosts(projects, servers.servers, ssh), [projects, servers, ssh])
  const apps = useMemo(() => inboxApps(projects, runs, dismissed), [projects, runs, dismissed])
  const phone = statusPhone(mobile)

  const openRun = (app: InboxApp): void => openRunLog(app, { selectedProjectId, selectedTaskId, switchToTask })

  return (
    <footer
      className="shrink-0 flex items-stretch h-[26px] border-t-[0.5px] border-hair bg-surface overflow-hidden select-none"
      data-testid="desk-status-bar"
    >
      {hosts.map(host => {
        const content = (
          <>
            <Dot tone={host.tone} />
            <span className="truncate">{host.label}</span>
            {host.detail && <span className="text-text-subtle">· {host.detail}</span>}
          </>
        )
        // A server's page has its pairing, build and updates; This Mac and SSH boxes open the hosts list.
        const page = host.kind === 'server' ? 'servers' : 'hosts'
        return (
          <button key={host.key} type="button" className={BUTTON} title={`${host.title} · open Settings › ${host.kind === 'server' ? 'Servers' : 'Hosts'}`} onClick={() => paletteEvents.emit('open-settings-tab', page)} data-testid="desk-status-host">
            {content}
          </button>
        )
      })}
      <span className="flex-1" />
      {apps.map(app => (
        <span key={streamRunKey(app.stream.id, app.run.commandId)} className="group flex items-stretch min-w-0 shrink" data-testid="desk-status-run" data-app-state={app.crashed ? 'crashed' : 'running'}>
          <button
            type="button"
            className={`${BUTTON} ${app.crashed ? 'group-hover:border-r-0' : ''}`}
            title={`${app.run.command}\n${app.crashed ? `Exited ${app.run.exitCode ?? '?'}` : 'Running'} · click for its log`}
            onClick={() => openRun(app)}
          >
            <Dot tone={app.crashed ? 'bad' : 'ok'} />
            <span className="truncate">{statusRunLabel(app)}</span>
          </button>
          {app.crashed && (
            <button
              type="button"
              className="hidden group-hover:flex items-center -ml-1 pr-1.5 bg-transparent border-0 border-r-[0.5px] border-hair cursor-pointer text-text-subtle hover:text-text"
              title="Dismiss until it runs again"
              onClick={() => dismissStreamRunCrash(app.stream.id, app.run)}
            >
              <X size={11} />
            </button>
          )}
        </span>
      ))}
      {phone && (
        <button
          type="button"
          className={BUTTON}
          title={phone.title}
          onClick={() => paletteEvents.emit('open-settings-tab', 'mobile')}
          data-testid="desk-status-phone"
        >
          <Dot tone={phone.tone} />
          <span className="truncate">{phone.label}</span>
          {phone.detail && <span className="text-text-subtle">· {phone.detail}</span>}
        </button>
      )}
    </footer>
  )
}

function Dot({ tone }: { tone: StatusTone }): React.ReactElement {
  return <span className={`size-[7px] shrink-0 rounded-full ${DOT[tone]}`} />
}

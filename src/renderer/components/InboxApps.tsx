import React, { useMemo } from 'react'
import { Play, RotateCw, Square, X } from 'lucide-react'
import type { Project } from '../../shared/types'
import { streamRunCommand } from '../../shared/stream-run'
import {
  controlStreamRun,
  dismissStreamRunCrash,
  openStreamRunLogs,
  useAllStreamRuns,
  useDismissedStreamRunCrashes
} from '../streamRuns'
import type { MenuAnchor } from '../hooks/useMenuPosition'
import { formatWaitTime, inboxApps, type InboxApp } from './inbox'
import { GroupHeader } from './InboxPanel'
import ProjectTileBadge from './ProjectTileBadge'
import { StreamRunBadge } from './StreamRunControls'
import { RowAction, RowActions } from './ui'

const TILE = 16

/**
 * The top of the Inbox: every stream's app that runs, or that crashed, across
 * all projects, so a dev server stays in sight while its stream has nothing
 * that needs you. Gone when nothing runs. A row opens the app's logs; hovering
 * offers Restart and Stop (Run and dismiss for a crash); right-click is the
 * stream's menu.
 */
export default function InboxApps({ projects, now, theme, showIcons, isUnreachable, onStreamMenu }: {
  projects: readonly Project[]
  now: number
  theme: 'dark' | 'light'
  showIcons: boolean
  /** A DevTool server's project whose server isn't online: dimmed, like the tree. */
  isUnreachable?: (project: Project) => boolean
  onStreamMenu: (at: MenuAnchor, projectId: string, streamId: string) => void
}): React.ReactElement | null {
  const projectIds = useMemo(() => projects.map(project => project.id), [projects])
  const runs = useAllStreamRuns(projectIds)
  const dismissed = useDismissedStreamRunCrashes()
  const apps = useMemo(() => inboxApps(projects, runs, dismissed), [projects, runs, dismissed])
  if (apps.length === 0) return null
  return (
    <div data-testid="inbox-group-apps">
      <GroupHeader label="Apps" count={apps.length} />
      {apps.map(app => (
        <AppRow
          key={app.stream.id}
          app={app}
          now={now}
          theme={theme}
          showIcon={showIcons}
          dimmed={!!isUnreachable?.(app.project)}
          onMenu={(at) => onStreamMenu(at, app.project.id, app.stream.id)}
        />
      ))}
    </div>
  )
}

function AppRow({ app, now, theme, showIcon, dimmed, onMenu }: {
  app: InboxApp
  now: number
  theme: 'dark' | 'light'
  showIcon: boolean
  dimmed: boolean
  onMenu: (at: MenuAnchor) => void
}): React.ReactElement {
  const { project, stream, run, crashed } = app
  const target = { projectId: project.id, streamId: stream.id }
  const command = streamRunCommand(project, stream)
  return (
    <div
      className={[
        'group flex items-center gap-1.5 mx-1.5 px-2 h-[26px] rounded-md cursor-pointer text-sm text-text',
        'hover:bg-surface-3 transition-colors duration-(--motion-fast)',
        dimmed ? 'opacity-55' : ''
      ].join(' ')}
      title={`${run.command}\n${crashed ? 'Crashed' : 'Running'} · click for logs`}
      onClick={() => openStreamRunLogs(target)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu({ x: e.clientX, y: e.clientY }) }}
      data-testid="inbox-app-row"
      data-stream-id={stream.id}
      data-app-state={crashed ? 'crashed' : 'running'}
    >
      <span className="flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
        <StreamRunBadge run={run} onClick={() => openStreamRunLogs(target)} />
      </span>
      {showIcon && <ProjectTileBadge project={project} theme={theme} size={TILE} />}
      <span className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden whitespace-nowrap">
        <span className={`font-semibold overflow-hidden text-ellipsis min-w-0 ${stream.isMain ? '' : 'shrink-0 max-w-[60%]'}`}>{project.name}</span>
        {!stream.isMain && (
          <>
            <span className="text-text-subtle shrink-0 text-xs">›</span>
            <span className="font-mono text-xs text-text-muted overflow-hidden text-ellipsis min-w-0">{stream.name}</span>
          </>
        )}
      </span>
      <span className="ml-auto flex items-center shrink-0" onMouseDown={(e) => e.stopPropagation()}>
        <span
          className={`text-2xs tabular-nums pl-1 ${crashed ? 'text-danger' : 'text-text-subtle group-hover:hidden'}`}
          data-testid="inbox-app-status"
        >
          {crashed ? `exited ${run.exitCode ?? '?'}` : formatWaitTime(now - run.startedAt)}
        </span>
        <RowActions>
          {crashed ? (
            <>
              {command && (
                <RowAction title={`Run the app: ${command}`} onClick={() => void controlStreamRun(project.id, stream.id, 'start')}>
                  <Play size={13} />
                </RowAction>
              )}
              <RowAction title="Dismiss until it runs again" onClick={() => dismissStreamRunCrash(stream.id, run)}>
                <X size={13} />
              </RowAction>
            </>
          ) : (
            <>
              <RowAction title="Restart the app" onClick={() => void controlStreamRun(project.id, stream.id, 'restart')}>
                <RotateCw size={12} />
              </RowAction>
              <RowAction title="Stop the app" onClick={() => void controlStreamRun(project.id, stream.id, 'stop')}>
                <Square size={12} />
              </RowAction>
            </>
          )}
        </RowActions>
      </span>
    </div>
  )
}

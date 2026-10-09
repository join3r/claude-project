import React, { useEffect, useState } from 'react'
import { useApp } from '../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince } from '../context/TabStatusContext'
import { GrpHead, FormGroup } from './ui'
import { useGitPosture } from '../hooks/useGitPosture'
import { useCommitHistory } from '../hooks/useCommitHistory'
import { useProjectArchive } from '../hooks/archiveStore'
import { isRemoteProject, isShellCommandProject } from '../../shared/types'
import { featureAvailable } from '../../shared/project-features'
import type { Project, Stream, TabStatusValue } from '../../shared/types'
import { archivedTasksOf, visibleArchive } from '../../shared/archive'
import { projectTasks, streamDirectory } from '../../shared/streams'
import { formatShortcutForApp } from '../../shared/shortcut-label'
import { paletteEvents } from '../palette/paletteEvents'
import { CommitHeatmap } from './CommitHeatmap'
import { PromptQueue } from './PromptQueue'
import { CommitSparkline } from './CommitSparkline'
import { formatRelativeTime } from './projectStats'
import { taskStatusChip, type TaskChipTone } from './taskHeaderState'
import { projectHomeSummary, streamTone, STREAM_TONE_LABEL } from './projectHomeState'

interface Props { projectId: string }

const TONE_DOT_CLS: Record<TaskChipTone, string> = {
  attention: 'bg-status-attention shadow-[0_0_3px_var(--color-status-attention)]',
  working: 'bg-status-working status-pulse',
  turn: 'bg-info',
  quiet: 'border border-border-strong'
}

const TONE_TEXT_CLS: Record<TaskChipTone, string> = {
  attention: 'text-status-attention',
  working: 'text-text-muted',
  turn: 'text-info',
  quiet: 'text-text-subtle'
}

const cardLinkCls = 'bg-transparent border-0 p-0 text-xs cursor-pointer text-text-subtle hover:text-text hover:underline'
const headerBtnCls = 'shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-md text-sm cursor-pointer transition-colors duration-(--motion-fast)'

function ToneDot({ tone, title }: { tone: TaskChipTone; title?: string }): React.ReactElement {
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${TONE_DOT_CLS[tone]}`} title={title} />
}

/**
 * One stream: its rolled-up status, branch and worktree state, its open tasks
 * (click to open), `Done (N)` (its archived tasks, opened read-only) and `+ Task`.
 */
function StreamCard({ project, stream, local, allStatuses, statusSince, now }: {
  project: Project
  stream: Stream
  local: boolean
  allStatuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  now: number
}): React.ReactElement {
  const { switchToTask, showArchived } = useApp()
  const [doneOpen, setDoneOpen] = useState(false)
  const archive = useProjectArchive(project.id, doneOpen)
  const workspace = stream.workspace
  const posture = useGitPosture(local && workspace ? streamDirectory(project, stream) : '', local && !!workspace, project.id)
  const tone = streamTone(stream, allStatuses, statusSince, now)
  const doneCount = stream.archivedTaskCount ?? 0
  const doneTasks = archive ? archivedTasksOf(visibleArchive(archive, project), stream.id) : []

  const where: string[] = []
  if (workspace) {
    where.push('worktree')
    if (posture?.isGitRepo) {
      if (posture.ahead > 0) where.push(`${posture.ahead} ahead`)
      if (posture.behind > 0) where.push(`${posture.behind} behind`)
      if (posture.dirtyCount > 0) where.push(`${posture.dirtyCount} dirty ${posture.dirtyCount === 1 ? 'file' : 'files'}`)
    }
  } else {
    where.push('project folder')
    if (stream.isMain) where.push('default stream')
  }

  return (
    <div
      className={`bg-field border rounded-lg p-3 flex flex-col gap-2 min-w-0 ${tone === 'attention' ? 'border-border-strong' : 'border-border'}`}
      data-testid={`home-stream-${stream.id}`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <ToneDot tone={tone} title={STREAM_TONE_LABEL[tone]} />
        <span className="font-mono font-semibold text-base truncate" title={stream.name}>{stream.name}</span>
        <span className="flex-1" />
        {workspace && (
          <span className="font-mono text-2xs text-text-subtle truncate max-w-[50%]" title={workspace.branchName}>⎇ {workspace.branchName}</span>
        )}
      </div>
      <div className="text-xs text-text-subtle">
        {where.join(' · ')}
        {tone !== 'quiet' && <span className={TONE_TEXT_CLS[tone]}> · {STREAM_TONE_LABEL[tone].toLowerCase()}</span>}
      </div>
      {stream.tasks.length > 0 && (
        <ul className="flex flex-col gap-0.5 m-0 p-0 list-none">
          {stream.tasks.map(task => {
            const chip = taskStatusChip(task, allStatuses, statusSince, now)
            return (
              <li key={task.id} className="min-w-0">
                <button
                  type="button"
                  className="w-full flex items-center gap-1.5 bg-transparent border-0 px-1 -mx-1 py-0.5 rounded-sm text-left text-sm text-text cursor-pointer hover:bg-surface-3 min-w-0"
                  title={task.name}
                  onClick={() => switchToTask(project.id, task.id)}
                >
                  <ToneDot tone={chip?.tone ?? 'quiet'} />
                  <span className="truncate">{task.name}</span>
                  <span className="flex-1" />
                  {chip && <span className={`shrink-0 text-xs ${TONE_TEXT_CLS[chip.tone]}`}>{chip.label.toLowerCase()}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex items-center gap-3">
        {doneCount > 0 && (
          <button type="button" className={cardLinkCls} onClick={() => setDoneOpen(!doneOpen)} aria-expanded={doneOpen}>
            Done ({doneCount})
          </button>
        )}
        <button
          type="button"
          className={cardLinkCls}
          onClick={() => paletteEvents.emit('open-new-task-in', { projectId: project.id, streamId: stream.id })}
        >
          + Task
        </button>
      </div>
      {doneOpen && (
        <ul className="flex flex-col gap-0.5 m-0 p-0 list-none">
          {!archive && <li className="text-xs text-text-subtle">Loading…</li>}
          {doneTasks.map(entry => (
            <li key={entry.task.id} className="min-w-0">
              <button
                type="button"
                className="w-full bg-transparent border-0 px-1 -mx-1 py-0.5 rounded-sm text-left text-xs text-text-muted cursor-pointer hover:bg-surface-3 truncate"
                title={`${entry.task.name} · archived`}
                onClick={() => showArchived({ projectId: project.id, kind: 'task', id: entry.task.id })}
              >
                {entry.task.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** "N archived streams": opens to their names, each opening read-only like the sidebar's Done group. */
function ArchivedStreamsLine({ project }: { project: Project }): React.ReactElement | null {
  const { showArchived } = useApp()
  const [open, setOpen] = useState(false)
  const archive = useProjectArchive(project.id, open)
  const count = project.archivedStreamCount ?? 0
  if (count === 0) return null
  const streams = archive
    ? [...visibleArchive(archive, project).streams].sort((a, b) => b.archivedAt - a.archivedAt)
    : []
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-text-subtle">
      <button type="button" className={cardLinkCls} onClick={() => setOpen(!open)} aria-expanded={open}>
        {count} archived {count === 1 ? 'stream' : 'streams'}
      </button>
      {open && !archive && <span>Loading…</span>}
      {open && streams.map((entry, index) => (
        <React.Fragment key={entry.stream.id}>
          {index > 0 && <span aria-hidden>·</span>}
          <button
            type="button"
            className={`${cardLinkCls} font-mono`}
            title={`${entry.stream.name} · ${entry.stream.tasks.length + entry.doneTasks.length} tasks · archived`}
            onClick={() => showArchived({ projectId: project.id, kind: 'stream', id: entry.stream.id })}
          >
            {entry.stream.name}
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

export function ProjectHome({ projectId }: Props): React.ReactElement | null {
  const actions = useApp()
  const project = actions.projects.find(p => p.id === projectId)
  const isLocal = project
    ? !isRemoteProject(project) && !isShellCommandProject(project) && featureAvailable(project, 'git-posture')
    : false
  const projectDir = isLocal && project?.directory ? project.directory : ''
  const posture = useGitPosture(projectDir, isLocal, project?.id)
  const { commits } = useCommitHistory(projectDir, isLocal, project?.id)
  const allStatuses = useAllTabStatuses()
  const statusSince = useAllTabStatusSince()
  const [now, setNow] = useState(() => Date.now())
  // "needs you · 4m" counts up, and snoozes wake, while Home stays open.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  if (!project) return null

  const summary = projectHomeSummary(project, allStatuses, statusSince, now)
  const visibleTasks = projectTasks(project)
  const mostRecentTask = visibleTasks
    .filter(t => t.lastInteractedAt)
    .sort((a, b) => (b.lastInteractedAt ?? 0) - (a.lastInteractedAt ?? 0))[0] ?? null
  const agentTotal = summary.agents.reduce((sum, agent) => sum + agent.count, 0)
  const openDetail = [
    summary.needsYou > 0 && `${summary.needsYou} need${summary.needsYou === 1 ? 's' : ''} you`,
    summary.working > 0 && `${summary.working} working`
  ].filter(Boolean).join(' · ')

  const lifetime = project.lifetimeStats ?? {
    tasksCreated: visibleTasks.length,
    notesCreated: (actions.notes[project.id] ?? []).length
  }
  const where = project.ssh ? `${project.ssh.host}:${project.ssh.remoteDir}` : project.directory

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-y-auto bg-bg text-text">
      <div className="px-4 py-3 max-w-[760px] w-full mx-auto flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-3 mb-2">
          <div className="flex-1 basis-[240px] flex flex-col gap-0.5 min-w-0">
            <h1 className="m-0 text-xl font-semibold text-text truncate">{project.name}</h1>
            {where && <span className="font-mono text-xs text-text-subtle truncate" title={where}>{where}</span>}
          </div>
          <button
            type="button"
            className={`${headerBtnCls} bg-transparent border border-border-strong text-text hover:bg-surface-3`}
            onClick={() => paletteEvents.emit('open-new-stream', project.id)}
          >
            New stream <span className="text-xs text-text-subtle">{formatShortcutForApp('CmdOrCtrl+Alt+N')}</span>
          </button>
          <button
            type="button"
            className={`${headerBtnCls} border-0 bg-accent text-accent-ink font-medium hover:brightness-105`}
            onClick={() => paletteEvents.emit('open-new-task-in', { projectId: project.id })}
          >
            New task <span className="text-xs opacity-70">{formatShortcutForApp('CmdOrCtrl+N')}</span>
          </button>
        </div>

        {!isShellCommandProject(project) && <PromptQueue project={project} />}

        <GrpHead>Streams</GrpHead>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
          {project.streams.map(stream => (
            <StreamCard
              key={stream.id}
              project={project}
              stream={stream}
              local={isLocal}
              allStatuses={allStatuses}
              statusSince={statusSince}
              now={now}
            />
          ))}
        </div>
        <ArchivedStreamsLine project={project} />

        {isLocal && (
          <>
            <GrpHead>Git</GrpHead>
            <FormGroup>
              {!posture ? (
                <div className="text-base text-text-subtle">Loading…</div>
              ) : !posture.isGitRepo ? (
                <div className="text-base text-text-subtle">Not a git repository.</div>
              ) : (
                <div className="text-base text-text leading-[1.6]">
                  <div>
                    on <span className="font-mono">{posture.branch ?? '(detached)'}</span>
                    {posture.upstream && (
                      <>
                        {' · '}
                        <span className={posture.ahead > 0 ? 'text-success' : 'text-text-subtle'}>{posture.ahead} ahead</span>
                        {', '}
                        <span className={posture.behind > 0 ? 'text-warn' : 'text-text-subtle'}>{posture.behind} behind</span>
                      </>
                    )}
                    {' · '}
                    <span className={posture.dirtyCount > 0 ? 'text-warn' : 'text-text-subtle'}>{posture.dirtyCount} dirty</span>
                  </div>
                  {posture.lastCommit && (
                    <div className="text-text-subtle text-xs mt-1 truncate" title={posture.lastCommit.subject}>
                      last: {posture.lastCommit.subject} · {formatRelativeTime(new Date(posture.lastCommit.isoDate).getTime())} · {posture.lastCommit.author}
                    </div>
                  )}
                </div>
              )}
            </FormGroup>
          </>
        )}

        <GrpHead>Activity</GrpHead>
        <div className="grid grid-cols-3 gap-2">
          <FormGroup>
            <div className="text-xs text-text-muted">Open tasks</div>
            <div className="text-xl font-semibold text-text">{summary.openTasks}</div>
            {openDetail && <div className="text-xs text-text-subtle">{openDetail}</div>}
            {mostRecentTask && mostRecentTask.lastInteractedAt && (
              <div className="text-xs text-text-subtle truncate" title={mostRecentTask.name}>
                last touched: {mostRecentTask.name} · {formatRelativeTime(mostRecentTask.lastInteractedAt)}
              </div>
            )}
          </FormGroup>
          <FormGroup>
            <div className="text-xs text-text-muted">Agents</div>
            <div className="text-xl font-semibold text-text">{agentTotal}</div>
            {summary.agents.length > 0 && (
              <ul className="text-xs text-text-subtle space-y-0.5">
                {summary.agents.map(agent => (
                  <li key={agent.label}>• {agent.count} {agent.label}</li>
                ))}
              </ul>
            )}
          </FormGroup>
          <FormGroup>
            <div className="text-xs text-text-muted">Lifetime</div>
            <div className="text-base text-text leading-[1.6]">
              <div><span className="text-xl font-semibold">{lifetime.tasksCreated}</span> tasks created</div>
              <div><span className="text-xl font-semibold">{lifetime.notesCreated}</span> notes written</div>
            </div>
          </FormGroup>
        </div>

        {isLocal && posture?.isGitRepo && (
          <>
            <CommitHeatmap isoTimestamps={commits} />
            <CommitSparkline isoTimestamps={commits} />
          </>
        )}
      </div>
    </div>
  )
}

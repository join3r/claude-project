import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Cog, MoreHorizontal, Plus } from 'lucide-react'
import { useApp } from '../../context/AppContext'
import { useAllTabStatuses, useAllTabStatusSince } from '../../context/TabStatusContext'
import { isRemoteProject, isShellCommandProject, type GitBranchGraph, type GitDiffSummary, type GitPostureResult, type Project, type Stream, type Task, type TabStatusValue } from '../../../shared/types'
import { featureAvailable } from '../../../shared/project-features'
import { findMainStream, projectTasks, streamDirectory } from '../../../shared/streams'
import { archivedTasksOf, visibleArchive } from '../../../shared/archive'
import { promptQueue, streamPromptQueue } from '../../../shared/prompt-queue'
import { runsOfStream, streamOwnRunCommands, streamRunCommands, streamRunCrashed, streamRunTask, type StreamRunState } from '../../../shared/stream-run'
import { projectSwatch, projectTile } from '../../../shared/project-label'
import { formatShortcutForApp } from '../../../shared/shortcut-label'
import { controlStreamRun, openStreamRunLogs, useAllStreamRuns } from '../../streamRuns'
import { serverName } from '../../serversState'
import { paletteEvents } from '../../palette/paletteEvents'
import { openEntityDialog } from '../../entityActions'
import { useGitPosture } from '../../hooks/useGitPosture'
import { useCommitHistory } from '../../hooks/useCommitHistory'
import { useProjectArchive } from '../../hooks/archiveStore'
import { formatLineCount, useTaskDiffSummaries } from '../../hooks/useTaskDiffSummaries'
import { EntityMenuPopup, type EntityMenuTarget } from '../menus/EntityMenus'
import ProjectTileBadge from '../ProjectTileBadge'
import { BranchGraph, projectBranchLabels, useBranchGraph } from '../BranchGraph'
import { CommitHeatmap } from '../CommitHeatmap'
import { PromptQueue } from '../PromptQueue'
import { ArchivedStreamsLine, DoneTaskItem } from './DoneItems'
import { StreamRunButtons } from '../StreamRunControls'
import { bucketByDay, formatRelativeTime, quartileBins } from '../projectStats'
import { taskAgentLabel, taskStatusChip, type TaskChipTone } from '../taskHeaderState'
import { projectHomeSummary } from '../projectHomeState'
import { aheadBehindLine, laneTrack, plural, projectHostLabel, quietFor, recentWeeks, type LaneTrack } from './projectMap'

const GRAPH_LIMIT = 150
const HEAT_WEEKS = 16

const ghostCls = 'shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-border-strong bg-transparent text-sm text-text cursor-pointer hover:bg-sel transition-colors duration-(--motion-fast)'
const smallGhostCls = 'shrink-0 inline-flex items-center h-6 px-2 rounded-md border border-border-strong bg-transparent text-xs text-text-muted cursor-pointer hover:text-text hover:bg-sel transition-colors duration-(--motion-fast)'
const linkCls = 'bg-transparent border-0 p-0 text-xs cursor-pointer text-text-muted hover:text-text hover:underline'
const headCls = 'text-2xs font-semibold uppercase tracking-[0.07em] text-text-muted'

/** A tip card's colours: amber needs you, blue your turn, grey working (pulsing), quiet otherwise. */
const TIP: Record<TaskChipTone, { card: string; dot: string; text: string }> = {
  attention: {
    card: 'border-[color-mix(in_srgb,var(--color-needs)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-needs)_7%,var(--color-field))]',
    dot: 'bg-needs',
    text: 'text-needs'
  },
  turn: { card: 'border-[color-mix(in_srgb,var(--color-answered)_35%,transparent)] bg-field', dot: 'bg-answered', text: 'text-answered' },
  working: { card: 'border-border bg-field', dot: 'bg-text-muted desk-pulse', text: 'text-text-muted' },
  quiet: { card: 'border-border bg-field', dot: 'border border-border-strong', text: 'text-text-subtle' }
}

/** A lane's horizontal track, kept scrolled to its newest end as it changes. */
function useScrolledToEnd(dep: unknown): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [dep])
  return ref
}

function TaskTip({ project, task, statuses, statusSince, now, diff }: {
  project: Project
  task: Task
  statuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  now: number
  diff: GitDiffSummary | undefined
}): React.ReactElement {
  const { switchToTask } = useApp()
  const chip = taskStatusChip(task, statuses, statusSince, now)
  const tone = chip?.tone ?? 'quiet'
  const agent = taskAgentLabel(task)
  const label = chip
    ? chip.tone === 'working' && agent && agent !== 'Claude' ? `${chip.label} · ${agent}` : chip.label
    : 'Open'
  return (
    <button
      type="button"
      className={`relative z-[1] flex-[0_1_180px] min-w-[128px] flex flex-col gap-[3px] px-2.5 py-2 rounded-[9px] border text-left cursor-pointer hover:brightness-110 ${TIP[tone].card}`}
      title={`${task.name} · ${label}`}
      onClick={() => switchToTask(project.id, task.id)}
      data-testid={`map-task-${task.id}`}
    >
      <span className="flex items-center gap-1.5">
        <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${TIP[tone].dot}`} />
        <span className={`text-2xs ${TIP[tone].text} truncate`}>{label}</span>
      </span>
      <span className="text-xs font-medium text-text truncate">{task.name}</span>
      {diff && (diff.added > 0 || diff.deleted > 0) && (
        <span className="font-mono text-2xs text-text-subtle">
          <span className="text-running">+{formatLineCount(diff.added)}</span> <span className="text-crashed">−{formatLineCount(diff.deleted)}</span>
        </span>
      )}
    </button>
  )
}

/** One command at a lane's end: state dot, name, Run (Restart/Stop while it runs) and its Logs. */
function CommandRow({ project, stream, id, name, command, run, defined }: {
  project: Project
  stream: Stream
  id: string
  name: string
  command: string
  run: StreamRunState | undefined
  defined: boolean
}): React.ReactElement {
  const dot = run?.status === 'running' ? 'bg-running' : run && streamRunCrashed(run) ? 'bg-crashed' : 'bg-border-strong'
  const task = streamRunTask(stream, run)
  const state = run?.status === 'running' ? 'running' : run && streamRunCrashed(run) ? `crashed (${run.exitCode ?? '?'})` : run?.status ?? 'not running'
  return (
    <div className="flex items-center gap-2 min-w-0 text-xs" data-testid={`map-run-${stream.id}-${id}`}>
      <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${dot}`} />
      <span className="flex-1 min-w-0 font-mono text-text truncate" title={`$ ${command} · ${state}${task ? ` · in ${task.name}` : ''}`}>
        {name}{task && <span className="text-text-subtle"> · {task.name}</span>}
      </span>
      <StreamRunButtons run={run} canRun={defined} name={name} onAction={(action) => void controlStreamRun(project.id, stream.id, id, action)} />
      {run && (
        <button type="button" className={smallGhostCls} onClick={() => openStreamRunLogs({ projectId: project.id, streamId: stream.id, commandId: id })}>
          Logs
        </button>
      )}
    </div>
  )
}

/**
 * The lane's end: the stream's commands, and its queue. A non-main stream's
 * commands that only repeat the project's and never ran here fold into
 * "Inherits dev, test", which opens to their rows.
 */
function LaneEnd({ project, stream, runs, onOpenQueue }: {
  project: Project
  stream: Stream
  runs: readonly StreamRunState[]
  onOpenQueue: (streamId: string) => void
}): React.ReactElement {
  const [showInherited, setShowInherited] = useState(false)
  const commands = streamRunCommands(project, stream)
  const own = new Set(streamOwnRunCommands(project, stream).map(c => c.name.trim().toLowerCase()))
  const ids = new Set(commands.map(c => c.id))
  const rows = [
    ...commands.map(c => ({ ...c, defined: true, inherited: !stream.isMain && !own.has(c.name.trim().toLowerCase()) })),
    // A command removed while it ran keeps its row until the run is gone.
    ...runs.filter(r => !ids.has(r.commandId)).map(r => ({ id: r.commandId, name: r.name, command: r.command, defined: false, inherited: false }))
  ]
  const runOf = (id: string) => runs.find(r => r.commandId === id)
  const folded = showInherited ? [] : rows.filter(r => r.inherited && !runOf(r.id))
  const shown = rows.filter(r => !folded.includes(r))
  const queued = isShellCommandProject(project) ? 0 : streamPromptQueue(project, stream.id).length
  const main = findMainStream(project)

  return (
    <div className="min-w-0 px-5 pt-1 pb-4 @min-[860px]:pt-4 @min-[860px]:flex-[0_0_260px] @min-[860px]:border-l border-hair flex flex-col gap-2 box-border">
      {shown.map(row => (
        <CommandRow key={row.id} project={project} stream={stream} id={row.id} name={row.name} command={row.command} run={runOf(row.id)} defined={row.defined} />
      ))}
      {folded.length > 0 && (
        <button type="button" className={`${linkCls} text-left`} onClick={() => setShowInherited(true)} title="Show them to run them in this stream">
          Inherits <span className="font-mono">{folded.map(r => r.name).join(', ')}</span>{main ? ` from ${main.name}` : ''}
        </button>
      )}
      {rows.length === 0 && <span className="text-xs text-text-subtle">No commands</span>}
      {!isShellCommandProject(project) && (queued > 0 || stream.promptQueueAutoRun) && (
        <span className="text-xs text-text-subtle">
          Queue · {queued} {plural(queued, 'prompt')}{stream.promptQueueAutoRun ? ' · runs next automatically' : ''} ·{' '}
          <button type="button" className={linkCls} onClick={() => onOpenQueue(stream.id)}>open</button>
        </span>
      )}
    </div>
  )
}

/**
 * One stream as a lane (board Project.dc.html): the head names it, its branch
 * and where it lives, and how it stands against its base; the track draws its
 * commits older → newer with its open tasks as tips; the end runs its commands.
 */
function StreamLane({ project, stream, graph, track, local, folderPosture, statuses, statusSince, now, diffs, runs, onOpenQueue }: {
  project: Project
  stream: Stream
  graph: GitBranchGraph | null
  track: LaneTrack
  local: boolean
  folderPosture: GitPostureResult | null
  statuses: Record<string, TabStatusValue>
  statusSince: Record<string, number>
  now: number
  diffs: ReadonlyMap<string, GitDiffSummary>
  runs: readonly StreamRunState[]
  onOpenQueue: (streamId: string) => void
}): React.ReactElement {
  const [menu, setMenu] = useState<EntityMenuTarget | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const archive = useProjectArchive(project.id, doneOpen)
  const ownPosture = useGitPosture(local && stream.workspace ? streamDirectory(project, stream) : '', local && !!stream.workspace, project.id)
  const posture = stream.workspace ? ownPosture : folderPosture
  const trackRef = useScrolledToEnd(track.items.length)
  const openMenu = (x: number, y: number) => setMenu({ x, y, kind: 'stream', projectId: project.id, streamId: stream.id })
  const doneCount = stream.archivedTaskCount ?? 0
  const doneTasks = archive ? archivedTasksOf(visibleArchive(archive, project), stream.id) : []
  const swatch = projectSwatch(projectTile(project), 'dark')
  const rail = stream.isMain ? swatch.bg : stream.workspace ? 'var(--color-text-subtle)' : 'var(--color-border-strong)'
  const quiet = stream.tasks.length === 0

  // The state line: the project folder's dirty files and origin; a worktree's base and its own dirty files.
  const state: string[] = []
  if (posture?.isGitRepo) {
    if (stream.workspace) {
      const line = aheadBehindLine(track, stream.workspace.baseBranch)
      if (line) state.push(line)
    } else if (stream.isMain && posture.upstream) {
      state.push(posture.ahead === 0 && posture.behind === 0
        ? `even with ${posture.upstream}`
        : [posture.ahead > 0 && `${posture.ahead} ahead`, posture.behind > 0 && `${posture.behind} behind`].filter(Boolean).join(' · ') + ` ${posture.upstream}`)
    }
    if (stream.workspace || stream.isMain) state.unshift(posture.dirtyCount > 0 ? `${posture.dirtyCount} dirty ${plural(posture.dirtyCount, 'file')}` : 'clean')
  }
  const quietLine = [quiet && graph ? quietFor(track.newest?.isoDate, now) : null, quiet && !graph ? 'No open tasks' : null].filter(Boolean)[0]

  return (
    <div className="border-b border-hair" data-testid={`map-lane-${stream.id}`}>
      <div className={`flex flex-col @min-[860px]:flex-row ${quiet ? '@min-[860px]:min-h-[96px]' : '@min-[860px]:min-h-[124px]'}`}>
        <div
          className="min-w-0 px-5 pt-4 pb-1 @min-[860px]:pb-4 @min-[860px]:flex-[0_0_220px] flex flex-col gap-1 box-border"
          onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY) }}
        >
          <div className="flex items-center gap-1 min-w-0">
            <span className={`flex-1 min-w-0 font-mono text-[15px] font-medium truncate ${quiet ? 'text-text-muted' : 'text-text'}`} title={stream.name}>{stream.name}</span>
            <button
              type="button"
              className="shrink-0 flex items-center justify-center size-(--ctl-h-sm) rounded-md bg-transparent border-0 cursor-pointer text-text-subtle hover:text-text hover:bg-sel"
              title={`${stream.name}: stream actions`}
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              data-testid={`map-stream-menu-${stream.id}`}
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.bottom + 4) }}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
          <span className="font-mono text-xs text-text-muted truncate" title={stream.workspace?.worktreePath ?? project.directory}>
            {track.branch && <>⎇ {track.branch} · </>}{stream.workspace ? 'own worktree' : 'project folder'}
          </span>
          {state.length > 0 && <span className="text-xs text-text-muted">{state.join(' · ')}</span>}
          {stream.workspace && !aheadBehindLine(track, stream.workspace.baseBranch) && (
            <span className="text-xs text-text-subtle">from <span className="font-mono">{stream.workspace.baseBranch}</span></span>
          )}
          {doneCount > 0 && (
            <button type="button" className={`${linkCls} self-start mt-0.5`} onClick={() => setDoneOpen(!doneOpen)} aria-expanded={doneOpen}>
              Done {doneCount}
            </button>
          )}
          <EntityMenuPopup menu={menu} onClose={() => setMenu(null)} />
        </div>

        <div className="flex-1 min-w-0 relative flex items-center">
          <span aria-hidden className="absolute left-0 right-0 top-1/2 h-[2px] -translate-y-1/2" style={{ background: rail, opacity: stream.isMain || stream.workspace ? 0.9 : 0.6 }} />
          <div ref={trackRef} className="relative flex-1 min-w-0 flex items-center gap-6 px-6 py-3 overflow-x-auto [scrollbar-width:none]">
            {track.items.map(item => item.kind === 'commit'
              ? (
                  <span
                    key={item.commit.hash}
                    className="relative z-[1] shrink-0 w-[9px] h-[9px] rounded-full"
                    style={{ background: rail }}
                    title={`${item.commit.subject}\n${item.commit.hash.slice(0, 7)} · ${item.commit.author} · ${formatRelativeTime(new Date(item.commit.isoDate).getTime(), now)}`}
                  />
                )
              : <TaskTip key={item.task.id} project={project} task={item.task} statuses={statuses} statusSince={statusSince} now={now} diff={diffs.get(item.task.id)} />)}
            {quietLine && (
              <span className="relative z-[1] shrink-0 px-2 bg-bg text-xs text-text-muted">
                {quietLine}{doneCount > 0 ? ` · Done ${doneCount}` : ''}
              </span>
            )}
            <button
              type="button"
              className="relative z-[1] shrink-0 inline-flex items-center gap-1 h-7 px-2.5 rounded-[9px] border border-dashed border-border-strong bg-bg text-xs text-text-subtle cursor-pointer hover:text-text hover:border-text-subtle"
              title={`New task in ${stream.name}`}
              onClick={() => paletteEvents.emit('open-new-task-in', { projectId: project.id, streamId: stream.id })}
            >
              <Plus size={12} /> Task
            </button>
          </div>
        </div>

        <LaneEnd project={project} stream={stream} runs={runs} onOpenQueue={onOpenQueue} />
      </div>
      {doneOpen && (
        <ul className="m-0 list-none px-5 pb-3 pt-0 flex flex-col gap-0.5 max-w-[520px]" aria-label={`${stream.name}: done tasks`}>
          {!archive && <li className="text-xs text-text-subtle">Loading…</li>}
          {doneTasks.map(entry => <DoneTaskItem key={entry.task.id} project={project} entry={entry} />)}
        </ul>
      )}
    </div>
  )
}

/** The last weeks of commits on the project's branch, in the project's colour. */
function RecentHeat({ project, commits }: { project: Project; commits: string[] }): React.ReactElement {
  const cols = useMemo(() => recentWeeks(bucketByDay(commits), new Date(), HEAT_WEEKS), [commits])
  const bin = useMemo(() => quartileBins(cols.flat().map(d => d.count).filter(c => c > 0)), [cols])
  const swatch = projectSwatch(projectTile(project), 'dark')
  const total = cols.flat().reduce((sum, d) => sum + d.count, 0)
  return (
    <div className="flex gap-[3px]" role="img" aria-label={`${total} commits over the last ${HEAT_WEEKS} weeks`}>
      {cols.map((col, ci) => (
        <div key={ci} className="flex flex-col gap-[3px]">
          {col.map(day => {
            const level = bin(day.count)
            return (
              <span
                key={day.iso}
                className="w-[10px] h-[10px] rounded-[2px]"
                style={{ background: level === 0 ? 'var(--color-surface-3)' : swatch.bg, opacity: level === 0 ? 1 : 0.25 + level * 0.1875 }}
                title={`${day.date.toLocaleDateString()} · ${day.count} ${plural(day.count, 'commit')}`}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * The desk's Project page (plan change 4): one lane per stream, then the queue
 * and the activity. It takes the place of ProjectHome's cards, Git card,
 * branch graph, activity cards and heatmap; the full graph and the year
 * heatmap open from Activity › History.
 */
export default function DeskProjectMap({ projectId }: { projectId: string }): React.ReactElement | null {
  const { projects, notes, effectiveTheme, config } = useApp()
  const project = projects.find(p => p.id === projectId)
  const local = project
    ? !isRemoteProject(project) && !isShellCommandProject(project) && featureAvailable(project, 'git-posture')
    : false
  const projectDir = local && project?.directory ? project.directory : ''
  const posture = useGitPosture(projectDir, local, project?.id)
  const { commits } = useCommitHistory(projectDir, local, project?.id)
  const branches = useMemo(() => project ? [...projectBranchLabels(project, null).keys()].sort() : [], [project])
  const graph = useBranchGraph(projectDir, branches, GRAPH_LIMIT, local && !!posture?.isGitRepo, project?.id)
  const statuses = useAllTabStatuses()
  const statusSince = useAllTabStatusSince()
  const allRuns = useAllStreamRuns(project ? [project.id] : [])
  const [now, setNow] = useState(() => Date.now())
  const [history, setHistory] = useState(false)
  const queueRef = useRef<HTMLDivElement>(null)
  // "Needs you · 4m" counts up while the page stays open.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  const openTasks = useMemo(() => project ? project.streams.flatMap(stream => stream.tasks.map(task => ({ project, task }))) : [], [project])
  const diffs = useTaskDiffSummaries(openTasks)

  if (!project) return null

  const tracks = new Map(project.streams.map(stream => [stream.id, laneTrack(local ? graph : null, stream)]))
  const runsByStream = new Map(project.streams.map(stream => [stream.id, runsOfStream(allRuns, stream.id)]))
  const running = [...runsByStream.values()].flat().filter(run => run.status === 'running').length
  const queued = isShellCommandProject(project) ? 0 : promptQueue(project).length
  const tasks = projectTasks(project)
  const summary = projectHomeSummary(project, statuses, statusSince, now)
  const lifetime = project.lifetimeStats ?? { tasksCreated: tasks.length, notesCreated: (notes[project.id] ?? []).length }
  const where = project.ssh ? project.ssh.remoteDir : project.directory
  const shellCommand = project.shellCommand?.command.trim()
  const shellName = config?.hosts?.find(h => h.kind === 'shell' && h.command.trim() === shellCommand)
  const host = projectHostLabel(project, project.host ? serverName(project.host) : undefined, shellName?.kind === 'shell' ? shellName.name : undefined)
  const openQueue = (): void => queueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const stat = (n: number, label: string) => (
    <span><strong className="text-text text-[15px] font-semibold">{n}</strong> {label}</span>
  )

  return (
    <div className="@container flex-1 min-h-0 min-w-0 overflow-y-auto bg-bg text-text" data-testid="desk-project-map">
      <div className="px-7 pt-5 pb-4 flex flex-wrap items-end gap-x-6 gap-y-3 border-b border-hair">
        <div className="flex items-center gap-3.5 min-w-0">
          <ProjectTileBadge project={project} theme={effectiveTheme} size={44} />
          <div className="flex flex-col gap-0.5 min-w-0">
            <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em] truncate">{project.name}</h1>
            <span className="font-mono text-xs text-text-muted truncate" title={where}>{host}{where ? ` · ${where}` : ''}</span>
          </div>
        </div>
        <span className="flex-1" />
        <div className="flex flex-wrap gap-5 text-xs text-text-muted">
          {stat(project.streams.length, plural(project.streams.length, 'stream'))}
          {stat(tasks.length, plural(tasks.length, 'open task'))}
          {!isShellCommandProject(project) && stat(queued, 'queued')}
          {stat(running, running === 1 ? 'app running' : 'apps running')}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={`${ghostCls} border-transparent text-text-muted hover:text-text`} onClick={() => openEntityDialog({ kind: 'project-settings', projectId: project.id })} data-testid="map-project-settings">
            <Cog size={14} /> Settings
          </button>
          <button type="button" className={ghostCls} onClick={() => paletteEvents.emit('open-new-stream', project.id)} title={formatShortcutForApp('CmdOrCtrl+Alt+N')}>
            New stream
          </button>
          <button
            type="button"
            className={`${ghostCls} border-accent bg-accent text-accent-ink font-semibold hover:bg-accent hover:brightness-105`}
            onClick={() => paletteEvents.emit('open-new-task-in', { projectId: project.id })}
            title={formatShortcutForApp('CmdOrCtrl+N')}
          >
            New task
          </button>
        </div>
      </div>

      <div className="hidden @min-[860px]:flex py-2.5 border-b border-hair">
        <span className={`${headCls} flex-[0_0_220px] px-5 box-border`}>Stream</span>
        <span className={`${headCls} flex-1 px-6`}>Older ← commits and live tasks → newer</span>
        <span className={`${headCls} flex-[0_0_260px] px-5 box-border`}>Apps and queue</span>
      </div>

      {project.streams.map(stream => (
        <StreamLane
          key={stream.id}
          project={project}
          stream={stream}
          graph={local ? graph : null}
          track={tracks.get(stream.id)!}
          local={local}
          folderPosture={posture}
          statuses={statuses}
          statusSince={statusSince}
          now={now}
          diffs={diffs}
          runs={runsByStream.get(stream.id) ?? []}
          onOpenQueue={openQueue}
        />
      ))}
      <div className="px-5 py-2"><ArchivedStreamsLine project={project} /></div>

      <div className="flex flex-wrap gap-4 px-7 pt-2 pb-6">
        {!isShellCommandProject(project) && (
          <div ref={queueRef} className="flex-[1_1_420px] min-w-0 flex flex-col gap-2 scroll-mt-4">
            <PromptQueue project={project} />
          </div>
        )}
        <div className="flex-[1_1_320px] min-w-0 self-start mt-2 border border-border rounded-[10px] bg-field px-4 py-3.5 flex flex-col gap-2.5" data-testid="map-activity">
          <div className="flex items-center gap-2">
            <span className={headCls}>Activity</span>
            <span className="flex-1" />
            {local && posture?.isGitRepo && (
              <button type="button" className={linkCls} onClick={() => setHistory(!history)} aria-expanded={history}>
                {history ? 'Hide history' : 'History'}
              </button>
            )}
          </div>
          {local && posture?.isGitRepo && <RecentHeat project={project} commits={commits} />}
          {posture?.lastCommit && (
            <span className="text-xs text-text-muted truncate" title={posture.lastCommit.subject}>
              Last commit: {posture.lastCommit.subject} · {formatRelativeTime(new Date(posture.lastCommit.isoDate).getTime(), now)} · {posture.lastCommit.author}
            </span>
          )}
          <span className="text-xs text-text-muted">
            {summary.agents.length > 0 ? `Agents: ${summary.agents.map(a => `${a.count} ${a.label}`).join(', ')} · ` : ''}
            {lifetime.tasksCreated} {plural(lifetime.tasksCreated, 'task')} created · {lifetime.notesCreated} {plural(lifetime.notesCreated, 'note')} written
          </span>
        </div>
      </div>

      {history && local && (
        <div className="px-7 pb-8 flex flex-col gap-3" data-testid="map-history">
          <BranchGraph project={project} projectDir={projectDir} enabled />
          <CommitHeatmap isoTimestamps={commits} />
        </div>
      )}
    </div>
  )
}

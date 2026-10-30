import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../context/AppContext'
import { findMainStream } from '../../shared/streams'
import type { GitBranchGraph, Project } from '../../shared/types'
import { layoutGraph, type GraphRow } from './gitGraphLayout'
import { formatRelativeTime } from './projectStats'

const PAGE = 150
const POLL_MS = 15_000
const ROW_H = 24
const LANE_W = 14
const DOT_R = 3.5
const LANE_COLORS = [
  'var(--color-accent)',
  'var(--color-info)',
  'var(--color-success)',
  'var(--color-warn)',
  'var(--color-danger)',
  'var(--color-text-muted)'
]

const laneColor = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length]

/** What DevTool knows a branch as: a stream's, a task's, or the base a stream was cut from. */
export interface BranchLabel {
  branch: string
  kind: 'stream' | 'task' | 'base'
  /** The stream's or task's name; the branch itself for a base. */
  name: string
  /** Checked out in a worktree of its own (not the project folder). */
  worktree: boolean
  taskId?: string
}

/**
 * The project's branches, labelled. A branch that is more than one thing keeps
 * the first: a stream's own branch, then a task's, then the project folder's
 * (the default stream), then the bases streams were cut from.
 */
export function projectBranchLabels(project: Project, head: string | null): Map<string, BranchLabel> {
  const labels = new Map<string, BranchLabel>()
  const add = (label: BranchLabel) => { if (!labels.has(label.branch)) labels.set(label.branch, label) }
  for (const stream of project.streams) {
    if (stream.workspace) add({ branch: stream.workspace.branchName, kind: 'stream', name: stream.name, worktree: true })
  }
  for (const stream of project.streams) {
    for (const task of stream.tasks) {
      if (task.workspace) add({ branch: task.workspace.branchName, kind: 'task', name: task.name, worktree: true, taskId: task.id })
    }
  }
  const main = findMainStream(project)
  if (head) add({ branch: head, kind: 'stream', name: main?.name ?? head, worktree: false })
  for (const stream of project.streams) {
    if (stream.workspace) add({ branch: stream.workspace.baseBranch, kind: 'base', name: stream.workspace.baseBranch, worktree: false })
  }
  return labels
}

/** `projectId` routes the call to a DevTool server's project. */
export function useBranchGraph(projectDir: string, branches: string[], limit: number, enabled: boolean, projectId?: string): GitBranchGraph | null {
  const [graph, setGraph] = useState<GitBranchGraph | null>(null)
  const requestIdRef = useRef(0)
  const branchKey = branches.join('\n')

  const fetch = useCallback(() => {
    const requestId = ++requestIdRef.current
    if (!enabled || !projectDir) {
      setGraph(null)
      return
    }
    window.api.gitBranchGraph(projectDir, branchKey ? branchKey.split('\n') : [], limit, projectId)
      .then(result => { if (requestId === requestIdRef.current) setGraph(result) })
      .catch(() => { /* keep what's shown */ })
  }, [enabled, projectDir, branchKey, limit, projectId])

  useEffect(() => {
    fetch()
    const id = window.setInterval(fetch, POLL_MS)
    window.addEventListener('focus', fetch)
    return () => {
      requestIdRef.current += 1
      window.clearInterval(id)
      window.removeEventListener('focus', fetch)
    }
  }, [fetch])

  return graph
}

function RowLanes({ row, width }: { row: GraphRow; width: number }): React.ReactElement {
  const x = (lane: number) => lane * LANE_W + LANE_W / 2
  const mid = ROW_H / 2
  const color = laneColor(row.column)
  return (
    <svg width={width * LANE_W} height={ROW_H} className="shrink-0 block" aria-hidden>
      {row.segments.map((s, i) => {
        const [y1, y2] = s.part === 'top' ? [0, mid] : s.part === 'bottom' ? [mid, ROW_H] : [0, ROW_H]
        const d = s.from === s.to
          ? `M${x(s.from)} ${y1} L${x(s.to)} ${y2}`
          : `M${x(s.from)} ${y1} C${x(s.from)} ${(y1 + y2) / 2} ${x(s.to)} ${(y1 + y2) / 2} ${x(s.to)} ${y2}`
        return <path key={i} d={d} fill="none" stroke={laneColor(s.lane)} strokeWidth={1.5} />
      })}
      {row.merge
        ? <circle cx={x(row.column)} cy={mid} r={DOT_R} fill="var(--color-field)" stroke={color} strokeWidth={1.5} />
        : <circle cx={x(row.column)} cy={mid} r={DOT_R} fill={color} />}
    </svg>
  )
}

function BranchChip({ label, color, onOpenTask }: {
  label: BranchLabel
  color: string
  onOpenTask: (taskId: string) => void
}): React.ReactElement {
  const what = label.kind === 'stream' ? `Stream ${label.name}` : label.kind === 'task' ? `Task ${label.name}` : 'Base branch'
  const where = label.worktree ? 'own worktree' : label.kind === 'base' ? '' : 'project folder'
  const title = [what, `⎇ ${label.branch}`, where].filter(Boolean).join(' · ')
  const text = label.kind === 'base' ? label.branch : label.name
  const cls = `shrink-0 inline-flex items-center gap-1 max-w-[180px] h-[18px] px-1.5 rounded-sm border text-2xs truncate ${label.kind === 'task' ? 'text-text-muted' : 'font-mono font-semibold text-text'}`
  const content = (
    <>
      {label.worktree && <span aria-label="worktree" className="opacity-70">⌂</span>}
      <span className="truncate">{text}</span>
    </>
  )
  if (label.taskId) {
    const taskId = label.taskId
    return (
      <button type="button" className={`${cls} bg-transparent cursor-pointer hover:bg-surface-3`} style={{ borderColor: color }} title={title} onClick={() => onOpenTask(taskId)}>
        {content}
      </button>
    )
  }
  return <span className={cls} style={{ borderColor: color }} title={title}>{content}</span>
}

/**
 * The project's branches as a graph, newest first: the project folder's
 * branch, each stream's and each task's, and the commits that merged them.
 * Branch tips carry the stream or task they belong to. Only what git still
 * has: a deleted branch is gone, its work shows where it landed.
 */
export function BranchGraph({ project, projectDir, enabled }: {
  project: Project
  projectDir: string
  enabled: boolean
}): React.ReactElement | null {
  const { switchToTask } = useApp()
  const [limit, setLimit] = useState(PAGE)
  const known = projectBranchLabels(project, null)
  const branches = [...known.keys()].sort()
  const graph = useBranchGraph(projectDir, branches, limit, enabled, project.id)
  const layout = useMemo(() => layoutGraph(graph?.commits ?? []), [graph])
  if (!enabled) return null
  if (!graph) return <div className="text-base text-text-subtle">Loading…</div>
  if (graph.commits.length === 0) return <div className="text-base text-text-subtle">No commits.</div>

  const labels = projectBranchLabels(project, graph.head)
  const tipsAt = new Map<string, BranchLabel[]>()
  for (const [branch, sha] of Object.entries(graph.tips)) {
    const label = labels.get(branch)
    if (label) tipsAt.set(sha, [...(tipsAt.get(sha) ?? []), label])
  }
  const now = Date.now()

  return (
    <div className="flex flex-col min-w-0" data-testid="home-branch-graph">
      <div className="max-h-[480px] overflow-y-auto -mx-1">
        {layout.rows.map(row => {
          const tips = tipsAt.get(row.commit.hash) ?? []
          return (
            <div
              key={row.commit.hash}
              className="flex items-center gap-2 min-w-0 px-1 rounded-sm hover:bg-surface-3"
              style={{ height: ROW_H }}
              title={`${row.commit.subject}\n${row.commit.hash.slice(0, 10)} · ${row.commit.author} · ${new Date(row.commit.isoDate).toLocaleString()}`}
            >
              <RowLanes row={row} width={layout.width} />
              {tips.map(label => (
                <BranchChip key={label.branch} label={label} color={laneColor(row.column)} onOpenTask={(id) => switchToTask(project.id, id)} />
              ))}
              <span className={`flex-1 min-w-0 truncate text-sm ${row.merge ? 'text-text-muted' : 'text-text'}`}>{row.commit.subject}</span>
              <span className="shrink-0 text-xs text-text-subtle">{formatRelativeTime(new Date(row.commit.isoDate).getTime(), now)}</span>
              <span className="shrink-0 font-mono text-2xs text-text-subtle w-[7ch] text-right">{row.commit.hash.slice(0, 7)}</span>
            </div>
          )
        })}
        {graph.more && (
          <button
            type="button"
            className="mt-1 ml-1 bg-transparent border-0 p-0 text-xs cursor-pointer text-text-subtle hover:text-text hover:underline"
            onClick={() => setLimit(limit + PAGE)}
          >
            Load more
          </button>
        )}
      </div>
    </div>
  )
}

import React, { useMemo, useState } from 'react'
import { useApp } from '../context/AppContext'
import { isRemoteProject, isShellCommandProject, type Project } from '../../shared/types'
import { projectSwatch, projectTile } from '../../shared/project-label'
import {
  TOKEN_AGENT_LABEL,
  TOKEN_RANGES,
  dailyTotals,
  formatTokenCount,
  rowsInRange,
  sumBy,
  sumRows,
  totalTokens,
  type TokenCounts,
  type TokenRange,
  type TokenUsageRow
} from '../../shared/token-usage'
import { useTokenUsage } from '../hooks/useTokenUsage'
import { paletteEvents } from '../palette/paletteEvents'
import Modal from './ui/Modal'
import SegCtl from './ui/SegCtl'
import ProjectTileBadge from './ProjectTileBadge'

const headCls = 'text-2xs font-semibold uppercase tracking-[0.07em] text-text-muted'
const linkCls = 'bg-transparent border-0 p-0 text-xs cursor-pointer text-text-muted hover:text-text hover:underline'
const CHART_DAYS = 30

/** A project whose agent sessions a host can read (not SSH, not a shell command). */
export function tokenUsageAvailable(project: Project): boolean {
  return !isRemoteProject(project) && !isShellCommandProject(project)
}

function countsTitle(counts: TokenCounts): string {
  return [
    `${counts.input.toLocaleString()} input`,
    `${counts.output.toLocaleString()} output`,
    `${counts.cacheRead.toLocaleString()} cache read`,
    `${counts.cacheWrite.toLocaleString()} cache write`
  ].join('\n')
}

/** "in 1.2M · out 340k · cache 98M read, 4.1M write". */
function Breakdown({ counts }: { counts: TokenCounts }): React.ReactElement {
  return (
    <span className="text-xs text-text-muted tabular-nums" title={countsTitle(counts)}>
      in {formatTokenCount(counts.input)} · out {formatTokenCount(counts.output)} · cache {formatTokenCount(counts.cacheRead)} read, {formatTokenCount(counts.cacheWrite)} write
    </span>
  )
}

/** The last 30 days as bars in the project's colour, newest on the right; each bar's title has its day and total. */
function DailyBars({ rows, color }: { rows: readonly TokenUsageRow[]; color: string }): React.ReactElement {
  const days = useMemo(() => dailyTotals(rows, CHART_DAYS), [rows])
  const max = Math.max(1, ...days.map(d => d.total))
  return (
    <div className="flex items-end gap-[2px] h-10" role="img" aria-label={`Tokens per day over the last ${CHART_DAYS} days`}>
      {days.map(d => (
        <span key={d.day} className="flex-1 h-full flex items-end" title={`${new Date(`${d.day}T12:00:00`).toLocaleDateString()} · ${formatTokenCount(d.total)} tokens`}>
          <span
            className="w-full rounded-t-[2px]"
            style={{
              height: d.total > 0 ? `${Math.max(6, (d.total / max) * 100)}%` : '2px',
              background: d.total > 0 ? color : 'var(--color-surface-3)'
            }}
          />
        </span>
      ))}
    </div>
  )
}

/** Per agent and model, largest first: "Claude · claude-opus-5-5  412M". */
function ModelRows({ rows, limit }: { rows: readonly TokenUsageRow[]; limit: number }): React.ReactElement | null {
  const models = useMemo(() => sumBy(rows, row => `${row.agent}|${row.model}`), [rows])
  if (models.length === 0) return null
  const shown = models.slice(0, limit)
  const rest = models.slice(limit)
  return (
    <div className="flex flex-col gap-0.5">
      {shown.map(({ key, counts }) => {
        const [agent, model] = key.split('|') as [keyof typeof TOKEN_AGENT_LABEL, string]
        return (
          <div key={key} className="flex items-baseline gap-2 text-xs" title={countsTitle(counts)}>
            <span className="text-text-muted shrink-0">{TOKEN_AGENT_LABEL[agent]}</span>
            <span className="font-mono text-text truncate">{model}</span>
            <span className="flex-1" />
            <span className="tabular-nums text-text">{formatTokenCount(totalTokens(counts))}</span>
          </div>
        )
      })}
      {rest.length > 0 && (
        <div className="flex text-xs text-text-subtle">
          <span>{rest.length} more {rest.length === 1 ? 'model' : 'models'}</span>
          <span className="flex-1" />
          <span className="tabular-nums">{formatTokenCount(rest.reduce((sum, m) => sum + totalTokens(m.counts), 0))}</span>
        </div>
      )}
    </div>
  )
}

/** The Project page's Tokens card: the range's total, its split, the last 30 days and the models. */
export function ProjectTokensCard({ project }: { project: Project }): React.ReactElement {
  const [range, setRange] = useState<TokenRange>('30d')
  const usage = useTokenUsage([project.id])[project.id]
  const rows = usage?.report?.rows
  const inRange = useMemo(() => (rows ? rowsInRange(rows, range) : []), [rows, range])
  const counts = useMemo(() => sumRows(inRange), [inRange])
  const color = projectSwatch(projectTile(project), 'dark').bg

  return (
    <div className="flex-[1_1_320px] min-w-0 self-start mt-2 border border-border rounded-[10px] bg-field px-4 py-3.5 flex flex-col gap-2.5" data-testid="map-tokens">
      <div className="flex items-center gap-2">
        <span className={headCls}>Tokens</span>
        <span className="flex-1" />
        <button type="button" className={linkCls} onClick={() => paletteEvents.emit('open-token-usage')}>All projects</button>
      </div>
      {!usage || (usage.loading && !usage.report) ? (
        <span className="text-xs text-text-muted">Reading agent sessions…</span>
      ) : !usage.report ? (
        <span className="text-xs text-text-muted">Not available for this project&apos;s host.</span>
      ) : (
        <>
          <SegCtl compact options={TOKEN_RANGES} value={range} onChange={setRange} />
          <div className="flex items-baseline gap-2">
            <strong className="text-2xl font-semibold tabular-nums" data-testid="map-tokens-total">{formatTokenCount(totalTokens(counts))}</strong>
            <span className="text-xs text-text-muted">tokens</span>
          </div>
          <Breakdown counts={counts} />
          <DailyBars rows={usage.report.rows} color={color} />
          <ModelRows rows={inRange} limit={4} />
        </>
      )}
    </div>
  )
}

/**
 * Every project's tokens over a range, largest first, with the app's total
 * on top. A row opens its project's page.
 */
export function TokenUsageModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const { projects, effectiveTheme, selectProjectHome } = useApp()
  const [range, setRange] = useState<TokenRange>('30d')
  const readable = useMemo(() => projects.filter(tokenUsageAvailable), [projects])
  const ids = useMemo(() => readable.map(p => p.id), [readable])
  const usage = useTokenUsage(ids)

  const perProject = useMemo(() => readable.map(project => {
    const rows = usage[project.id]?.report?.rows ?? []
    const inRange = rowsInRange(rows, range)
    return { project, rows: inRange, counts: sumRows(inRange), loading: !!usage[project.id]?.loading && !usage[project.id]?.report }
  }).sort((a, b) => totalTokens(b.counts) - totalTokens(a.counts)), [readable, usage, range])
  const allRows = useMemo(() => perProject.flatMap(p => p.rows), [perProject])
  const total = useMemo(() => sumRows(allRows), [allRows])
  const byAgent = useMemo(() => sumBy(allRows, row => row.agent), [allRows])
  const max = Math.max(1, ...perProject.map(p => totalTokens(p.counts)))
  const loading = perProject.some(p => p.loading)
  const skipped = projects.length - readable.length

  const open = (project: Project): void => {
    selectProjectHome(project.id)
    onClose()
  }

  return (
    <Modal title="Token usage" onClose={onClose} width="w-[720px]">
      <div className="flex items-center gap-3">
        <SegCtl options={TOKEN_RANGES} value={range} onChange={setRange} />
        <span className="flex-1" />
        {loading && <span className="text-xs text-text-muted">Reading agent sessions…</span>}
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="flex flex-col gap-0.5">
          <span className={headCls}>All projects</span>
          <strong className="text-2xl font-semibold tabular-nums" data-testid="token-usage-total">{formatTokenCount(totalTokens(total))}</strong>
        </div>
        {byAgent.map(({ key, counts }) => (
          <div key={key} className="flex flex-col gap-0.5" title={countsTitle(counts)}>
            <span className={headCls}>{TOKEN_AGENT_LABEL[key]}</span>
            <span className="text-md tabular-nums text-text">{formatTokenCount(totalTokens(counts))}</span>
          </div>
        ))}
      </div>
      <Breakdown counts={total} />
      <div className="flex flex-col border-t border-hair" data-testid="token-usage-projects">
        {perProject.map(({ project, counts, loading: rowLoading }) => {
          const sum = totalTokens(counts)
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => open(project)}
              title={countsTitle(counts)}
              className="flex items-center gap-3 py-2 px-1 border-0 border-b border-hair bg-transparent text-left cursor-pointer hover:bg-sel rounded-sm"
            >
              <ProjectTileBadge project={project} theme={effectiveTheme} size={20} />
              <span className="w-44 shrink-0 truncate text-sm text-text">{project.name}</span>
              <span className="flex-1 min-w-0 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                {sum > 0 && <span className="block h-full rounded-full" style={{ width: `${Math.max(1, (sum / max) * 100)}%`, background: projectSwatch(projectTile(project), 'dark').bg }} />}
              </span>
              <span className="w-16 shrink-0 text-right text-sm tabular-nums text-text">{rowLoading ? '…' : sum > 0 ? formatTokenCount(sum) : '—'}</span>
            </button>
          )
        })}
      </div>
      <p className="m-0 text-xs text-text-subtle leading-snug">
        Counted from Claude Code, Codex and Pi session files in each project&apos;s folder and its worktrees, on the host the project lives on.
        DevTool keeps the totals after an agent deletes old sessions; history before DevTool first read them goes back as far as the agents kept it.
        {skipped > 0 ? ` ${skipped} SSH or shell-command ${skipped === 1 ? 'project is' : 'projects are'} not counted.` : ''}
      </p>
    </Modal>
  )
}

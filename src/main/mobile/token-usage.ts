import type { ProjectsData } from '../../shared/types'
import { localDay, type TokenUsageReport, type TokenUsageRow } from '../../shared/token-usage'
import {
  TOKENS_USAGE_DAILY_DAYS,
  type TokensUsageParams,
  type TokensUsageProject,
  type TokensUsageResult,
  type TokensUsageRow
} from '../../../protocol/ts/index.ts'
import { isVisibleOnMobile } from './inbox'
import { mobileProject, type MobileOutcome } from './new-stream'

/**
 * `tokens.usage` (SPEC.md §8.22): the Tokens card's and Token usage window's numbers
 * for a phone. Days older than the chart's 30 are summed per agent and model, so an
 * all-time answer stays small however long the agents have run.
 */

export interface TokensUsageDeps {
  peek(): ProjectsData
  /** The project's report as the desktop's own window gets it; null when its sessions aren't on this host. */
  usage(projectId: string): Promise<TokenUsageReport | null>
  now?: () => Date
}

/**
 * Rows from `firstDay` on as they are; older ones become one row per agent and
 * model, dated the earliest day they cover (before `firstDay`, so no range but
 * all time counts them).
 */
export function compactTokenRows(rows: readonly TokenUsageRow[], firstDay: string): TokensUsageRow[] {
  const recent: TokensUsageRow[] = []
  const older = new Map<string, TokensUsageRow>()
  for (const row of rows) {
    const out: TokensUsageRow = { day: row.day, agent: row.agent, model: row.model, input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite }
    if (row.day >= firstDay) {
      recent.push(out)
      continue
    }
    const key = `${row.agent}|${row.model}`
    const sum = older.get(key)
    if (!sum) {
      older.set(key, out)
      continue
    }
    if (row.day < sum.day) sum.day = row.day
    sum.input += row.input
    sum.output += row.output
    sum.cacheRead += row.cacheRead
    sum.cacheWrite += row.cacheWrite
  }
  return [...older.values(), ...recent]
}

export async function tokensUsage(deps: TokensUsageDeps, params: TokensUsageParams): Promise<MobileOutcome<{ result: TokensUsageResult }>> {
  const data = deps.peek()
  let projects = data.projects.filter(isVisibleOnMobile)
  if (params.projectId !== undefined) {
    const found = mobileProject(data, params.projectId)
    if (!found.ok) return found
    projects = [found.project]
  }
  const now = deps.now?.() ?? new Date()
  const firstDay = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (TOKENS_USAGE_DAILY_DAYS - 1)))
  const reports = await Promise.all(projects.map(p => deps.usage(p.id)))
  let scannedAt = 0
  const out: TokensUsageProject[] = projects.map((project, i) => {
    const report = reports[i]
    if (!report) return { projectId: project.id, rows: [], unavailable: true }
    scannedAt = Math.max(scannedAt, report.scannedAt)
    return { projectId: project.id, rows: compactTokenRows(report.rows, firstDay) }
  })
  return { ok: true, result: { today: localDay(now), scannedAt: scannedAt || now.getTime(), projects: out } }
}

/**
 * Token usage read from the agents' own session files (Claude Code, Codex, Pi),
 * per project: main sums each day's tokens per agent and model, a window or the
 * phone picks the range and sums again.
 */

export type TokenAgent = 'claude' | 'codex' | 'pi'

export const TOKEN_AGENT_LABEL: Record<TokenAgent, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' }

export interface TokenCounts {
  /** Fresh input (not read from the prompt cache). */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One day's tokens of one agent and model (`day` is `YYYY-MM-DD` in the host's time zone). */
export interface TokenUsageRow extends TokenCounts {
  day: string
  agent: TokenAgent
  model: string
}

export interface TokenUsageReport {
  rows: TokenUsageRow[]
  /** When the host last read the session files (ms). */
  scannedAt: number
}

export type TokenRange = 'today' | '7d' | '30d' | 'all'

export const TOKEN_RANGES: Array<{ value: TokenRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' }
]

export function emptyCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addCounts(into: TokenCounts, from: TokenCounts): TokenCounts {
  into.input += from.input
  into.output += from.output
  into.cacheRead += from.cacheRead
  into.cacheWrite += from.cacheWrite
  return into
}

export function totalTokens(counts: TokenCounts): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite
}

/** `YYYY-MM-DD` of `date` in the local time zone. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** The first day `range` covers, counting today; null for all time. */
export function rangeStartDay(range: TokenRange, now: Date = new Date()): string | null {
  if (range === 'all') return null
  const days = range === 'today' ? 1 : range === '7d' ? 7 : 30
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
  return localDay(start)
}

export function rowsInRange(rows: readonly TokenUsageRow[], range: TokenRange, now: Date = new Date()): TokenUsageRow[] {
  const start = rangeStartDay(range, now)
  return start ? rows.filter(row => row.day >= start) : [...rows]
}

export function sumRows(rows: readonly TokenUsageRow[]): TokenCounts {
  const sum = emptyCounts()
  for (const row of rows) addCounts(sum, row)
  return sum
}

/** Totals per key, largest first. */
export function sumBy<K extends string>(rows: readonly TokenUsageRow[], key: (row: TokenUsageRow) => K): Array<{ key: K; counts: TokenCounts }> {
  const sums = new Map<K, TokenCounts>()
  for (const row of rows) {
    const k = key(row)
    addCounts(sums.get(k) ?? sums.set(k, emptyCounts()).get(k)!, row)
  }
  return [...sums].map(([k, counts]) => ({ key: k, counts })).sort((a, b) => totalTokens(b.counts) - totalTokens(a.counts))
}

/** Each of the last `days` days (oldest first) with its total, zero when nothing ran. */
export function dailyTotals(rows: readonly TokenUsageRow[], days: number, now: Date = new Date()): Array<{ day: string; total: number }> {
  const byDay = new Map<string, number>()
  for (const row of rows) byDay.set(row.day, (byDay.get(row.day) ?? 0) + totalTokens(row))
  const out: Array<{ day: string; total: number }> = []
  for (let i = days - 1; i >= 0; i--) {
    const day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i))
    out.push({ day, total: byDay.get(day) ?? 0 })
  }
  return out
}

/** "812", "48k", "3.4M", "1.2B". */
export function formatTokenCount(tokens: number): string {
  const short = (n: number, unit: string): string => `${n >= 100 ? Math.round(n) : +n.toFixed(1)}${unit}`
  if (tokens >= 1e9) return short(tokens / 1e9, 'B')
  if (tokens >= 1e6) return short(tokens / 1e6, 'M')
  if (tokens >= 1e3) return short(tokens / 1e3, 'k')
  return String(Math.round(tokens))
}

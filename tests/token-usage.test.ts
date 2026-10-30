import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TokenUsageIndex, tallyClaudeLine, tallyCodexLine, tallyPiLine, type FileTally } from '../src/main/token-usage-index'
import { dailyTotals, formatTokenCount, localDay, rangeStartDay, rowsInRange, sumBy, sumRows, totalTokens, type TokenUsageRow } from '../src/shared/token-usage'

const T = '2026-10-30T10:00:00.000Z'
const DAY = localDay(new Date(T))

function tally(agent: FileTally['agent']): FileTally {
  return { agent, size: 0, mtimeMs: 0, offset: 0, cwd: null, buckets: {} }
}

function claudeLine(id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'assistant', cwd: '/p', timestamp: T, message: { id, model: 'claude-x', role: 'assistant', usage }, ...extra })
}

describe('tallyClaudeLine', () => {
  it('counts a message once although each content block repeats its usage', () => {
    const t = tally('claude')
    tallyClaudeLine(t, claudeLine('m1', { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }))
    tallyClaudeLine(t, claudeLine('m1', { input_tokens: 1, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }))
    tallyClaudeLine(t, claudeLine('m2', { input_tokens: 2, output_tokens: 3 }))
    expect(t.cwd).toBe('/p')
    expect(t.buckets[`${DAY}|claude-x`]).toEqual([3, 23, 100, 10])
  })

  it('skips user lines and synthetic turns', () => {
    const t = tally('claude')
    tallyClaudeLine(t, JSON.stringify({ type: 'user', timestamp: T, message: { role: 'user', content: '"usage" "assistant"' } }))
    tallyClaudeLine(t, JSON.stringify({ type: 'assistant', timestamp: T, message: { id: 's', model: '<synthetic>', usage: { input_tokens: 9 } } }))
    expect(t.buckets).toEqual({})
  })
})

describe('tallyCodexLine', () => {
  it('takes the difference of running totals, with cached input split out', () => {
    const t = tally('codex')
    const count = (input: number, cached: number, output: number): string =>
      JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } })
    tallyCodexLine(t, JSON.stringify({ timestamp: T, type: 'session_meta', payload: { cwd: '/c' } }))
    tallyCodexLine(t, JSON.stringify({ timestamp: T, type: 'turn_context', payload: { cwd: '/c', model: 'gpt-x' } }))
    tallyCodexLine(t, count(100, 40, 10))
    tallyCodexLine(t, count(100, 40, 10)) // repeated count: nothing new
    tallyCodexLine(t, count(250, 140, 30))
    expect(t.cwd).toBe('/c')
    expect(t.buckets[`${DAY}|gpt-x`]).toEqual([110, 30, 140, 0])
  })
})

describe('tallyPiLine', () => {
  it('reads the header cwd and each assistant message', () => {
    const t = tally('pi')
    tallyPiLine(t, JSON.stringify({ type: 'session', cwd: '/pi', timestamp: T }))
    tallyPiLine(t, JSON.stringify({ type: 'message', timestamp: T, message: { role: 'assistant', model: 'm', usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } } }))
    tallyPiLine(t, JSON.stringify({ type: 'message', timestamp: T, message: { role: 'user', usage: { input: 99 } } }))
    expect(t.cwd).toBe('/pi')
    expect(t.buckets[`${DAY}|m`]).toEqual([5, 6, 7, 8])
  })
})

describe('TokenUsageIndex', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const roots = (): { claude: string; codex: string[]; pi: string } => ({
    claude: path.join(dir, 'claude'), codex: [path.join(dir, 'codex')], pi: path.join(dir, 'pi')
  })
  const session = (cwd: string, id: string, output: number): string =>
    `${JSON.stringify({ type: 'assistant', cwd, timestamp: T, message: { id, model: 'claude-x', usage: { output_tokens: output } } })}\n`

  it('reads only what was appended, survives a restart and splits nested projects', async () => {
    const file = path.join(dir, 'claude', '-a', 's1.jsonl')
    const nested = path.join(dir, 'claude', '-a-b', 'sub', 'subagents', 's2.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.mkdirSync(path.dirname(nested), { recursive: true })
    fs.writeFileSync(file, session('/a/.worktrees/t1', 'm1', 10) + '{"partial')
    fs.writeFileSync(nested, session('/a/b', 'm9', 1000))
    const cache = path.join(dir, 'cache.json')

    const index = new TokenUsageIndex(cache, roots())
    await index.refresh(true)
    expect(sumRows(index.rowsFor(['/a'], ['/a/b'])).output).toBe(10)
    expect(sumRows(index.rowsFor(['/a/b'], ['/a'])).output).toBe(1000)

    // The half-written line completes; one more message follows.
    fs.appendFileSync(file, `"}\n${session('/a', 'm2', 5)}`)
    const again = new TokenUsageIndex(cache, roots())
    await again.refresh(true)
    expect(sumRows(again.rowsFor(['/a'], ['/a/b'])).output).toBe(15)

    // A deleted session keeps counting.
    fs.rmSync(file)
    await again.refresh(true)
    expect(sumRows(again.rowsFor(['/a'], ['/a/b'])).output).toBe(15)
  })
})

describe('shared helpers', () => {
  const now = new Date(2026, 9, 30, 12)
  const row = (day: string, agent: TokenUsageRow['agent'], output: number): TokenUsageRow => ({ day, agent, model: 'm', input: 0, output, cacheRead: 0, cacheWrite: 0 })
  const rows = [row('2026-10-30', 'claude', 1), row('2026-10-25', 'codex', 10), row('2026-09-01', 'claude', 100)]

  it('filters by range and sums', () => {
    expect(rangeStartDay('today', now)).toBe('2026-10-30')
    expect(rangeStartDay('7d', now)).toBe('2026-10-24')
    expect(totalTokens(sumRows(rowsInRange(rows, 'today', now)))).toBe(1)
    expect(totalTokens(sumRows(rowsInRange(rows, '7d', now)))).toBe(11)
    expect(totalTokens(sumRows(rowsInRange(rows, 'all', now)))).toBe(111)
    expect(sumBy(rows, r => r.agent).map(s => s.key)).toEqual(['claude', 'codex'])
  })

  it('lists every day of the chart, zero when idle', () => {
    const days = dailyTotals(rows, 7, now)
    expect(days).toHaveLength(7)
    expect(days[6]).toEqual({ day: '2026-10-30', total: 1 })
    expect(days[1]).toEqual({ day: '2026-10-25', total: 10 })
  })

  it('formats counts short', () => {
    expect(formatTokenCount(812)).toBe('812')
    expect(formatTokenCount(48_200)).toBe('48.2k')
    expect(formatTokenCount(3_400_000)).toBe('3.4M')
    expect(formatTokenCount(1_234_000_000)).toBe('1.2B')
    expect(formatTokenCount(386_000_000)).toBe('386M')
  })
})

import { describe, expect, it } from 'vitest'
import { compactTokenRows, tokensUsage } from '../src/main/mobile/token-usage'
import type { TokenUsageReport, TokenUsageRow } from '../src/shared/token-usage'
import type { ProjectsData } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

const NOW = new Date(2026, 9, 30, 15, 0)

function row(day: string, model: string, input: number, agent: TokenUsageRow['agent'] = 'claude'): TokenUsageRow {
  return { day, agent, model, input, output: 1, cacheRead: 10, cacheWrite: 0 }
}

const data: ProjectsData = {
  projects: [
    fixtureProject({ id: 'p1', name: 'api', directory: '/src/api' }),
    fixtureProject({ id: 'p2', name: 'box', directory: '/home/me/box', ssh: { host: 'box', port: 22, username: 'me', remoteDir: '/home/me/box' } }),
    fixtureProject({ id: 'p3', name: 'secret', directory: '/src/secret', hideFromMobile: true })
  ],
  tags: [], projectOrder: ['p1', 'p2', 'p3'], pinnedItems: []
}

function deps(reports: Record<string, TokenUsageReport | null>) {
  const asked: string[] = []
  return {
    asked,
    deps: {
      peek: () => data,
      usage: async (projectId: string) => { asked.push(projectId); return reports[projectId] ?? null },
      now: () => NOW
    }
  }
}

describe('compactTokenRows (SPEC.md §8.22)', () => {
  it('keeps the last 30 days as they are and sums older days per agent and model, dated the earliest', () => {
    const rows = [row('2026-10-30', 'opus', 5), row('2026-10-01', 'opus', 4), row('2026-09-30', 'opus', 3), row('2026-08-02', 'opus', 2), row('2026-09-01', 'gpt', 1, 'codex')]
    expect(compactTokenRows(rows, '2026-10-01')).toEqual([
      { day: '2026-08-02', agent: 'claude', model: 'opus', input: 5, output: 2, cacheRead: 20, cacheWrite: 0 },
      { day: '2026-09-01', agent: 'codex', model: 'gpt', input: 1, output: 1, cacheRead: 10, cacheWrite: 0 },
      row('2026-10-30', 'opus', 5),
      row('2026-10-01', 'opus', 4)
    ])
  })
})

describe('tokensUsage (SPEC.md §8.22)', () => {
  it('answers every visible project, unavailable ones without rows, and never asks about a hidden one', async () => {
    const r = deps({ p1: { rows: [row('2026-10-30', 'opus', 5), row('2026-01-01', 'opus', 7)], scannedAt: 42 } })
    const outcome = await tokensUsage(r.deps, {})
    expect(outcome).toEqual({
      ok: true,
      result: {
        today: '2026-10-30',
        scannedAt: 42,
        projects: [
          { projectId: 'p1', rows: [row('2026-01-01', 'opus', 7), row('2026-10-30', 'opus', 5)] },
          { projectId: 'p2', rows: [], unavailable: true }
        ]
      }
    })
    expect(r.asked).toEqual(['p1', 'p2'])
  })

  it('answers one project, and not-found for an unknown or hidden one', async () => {
    const r = deps({ p1: { rows: [], scannedAt: 0 } })
    expect(await tokensUsage(r.deps, { projectId: 'p1' })).toEqual({ ok: true, result: { today: '2026-10-30', scannedAt: NOW.getTime(), projects: [{ projectId: 'p1', rows: [] }] } })
    expect(await tokensUsage(r.deps, { projectId: 'p3' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await tokensUsage(r.deps, { projectId: 'nope' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(r.asked).toEqual(['p1'])
  })
})

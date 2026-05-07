// tests/palette-frecency.test.ts
import { describe, it, expect } from 'vitest'
import { computeFrecencyMultiplier, recordUse, recentIds } from '../src/renderer/palette/frecency'

const DAY = 24 * 60 * 60 * 1000

describe('computeFrecencyMultiplier', () => {
  it('returns 1 when no record exists', () => {
    expect(computeFrecencyMultiplier(undefined, Date.now())).toBe(1)
  })
  it('grows with use count (log-scaled)', () => {
    const now = Date.now()
    const a = computeFrecencyMultiplier({ lastUsedAt: now, useCount: 1 }, now)
    const b = computeFrecencyMultiplier({ lastUsedAt: now, useCount: 10 }, now)
    expect(b).toBeGreaterThan(a)
  })
  it('decays toward 1 as time passes (~14d half-life)', () => {
    const now = Date.now()
    const fresh = computeFrecencyMultiplier({ lastUsedAt: now, useCount: 5 }, now)
    const old = computeFrecencyMultiplier({ lastUsedAt: now - 60 * DAY, useCount: 5 }, now)
    expect(fresh).toBeGreaterThan(old)
    expect(old).toBeCloseTo(1, 0)
  })
})

describe('recordUse', () => {
  it('increments useCount and updates lastUsedAt', () => {
    const before = { 'cmd.x': { lastUsedAt: 1000, useCount: 2 } }
    const after = recordUse(before, 'cmd.x', 5000)
    expect(after['cmd.x']).toEqual({ lastUsedAt: 5000, useCount: 3 })
  })
  it('initializes a missing entry with useCount=1', () => {
    const after = recordUse({}, 'cmd.new', 1000)
    expect(after['cmd.new']).toEqual({ lastUsedAt: 1000, useCount: 1 })
  })
  it('does not mutate the input object', () => {
    const before = { 'cmd.x': { lastUsedAt: 1000, useCount: 2 } }
    recordUse(before, 'cmd.x', 5000)
    expect(before['cmd.x']).toEqual({ lastUsedAt: 1000, useCount: 2 })
  })
})

describe('recentIds', () => {
  it('returns ids sorted by lastUsedAt descending', () => {
    const state = {
      a: { lastUsedAt: 100, useCount: 1 },
      b: { lastUsedAt: 300, useCount: 1 },
      c: { lastUsedAt: 200, useCount: 1 }
    }
    expect(recentIds(state, 8)).toEqual(['b', 'c', 'a'])
  })
  it('caps to limit', () => {
    const state = {
      a: { lastUsedAt: 1, useCount: 1 },
      b: { lastUsedAt: 2, useCount: 1 },
      c: { lastUsedAt: 3, useCount: 1 }
    }
    expect(recentIds(state, 2)).toEqual(['c', 'b'])
  })
})

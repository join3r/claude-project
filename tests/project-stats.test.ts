import { describe, it, expect } from 'vitest'
import {
  bucketByDay,
  bucketByMonth,
  quartileBins,
  yearRangeFromHistory,
  formatRelativeTime
} from '../src/renderer/components/projectStats'

describe('bucketByDay', () => {
  it('counts commits per local YYYY-MM-DD', () => {
    const isos = [
      '2026-05-08T10:00:00+02:00',
      '2026-05-08T22:30:00+02:00',
      '2026-05-09T01:00:00+02:00'
    ]
    const m = bucketByDay(isos)
    expect(m.get('2026-05-08')).toBe(2)
    expect(m.get('2026-05-09')).toBe(1)
  })
  it('returns empty map for empty input', () => {
    expect(bucketByDay([]).size).toBe(0)
  })
  it('skips invalid timestamps without throwing', () => {
    const m = bucketByDay(['not-a-date', '2026-01-01T00:00:00Z'])
    expect(m.size).toBe(1)
  })
})

describe('bucketByMonth', () => {
  it('counts commits per YYYY-MM', () => {
    const m = bucketByMonth([
      '2026-01-15T12:00:00Z',
      '2026-01-31T12:00:00Z',
      '2026-02-01T12:00:00Z'
    ])
    expect(m.get('2026-01')).toBe(2)
    expect(m.get('2026-02')).toBe(1)
  })
})

describe('quartileBins', () => {
  it('returns 0 for empty days, then 1..4 by quartile of non-empty counts', () => {
    // counts: [1, 2, 3, 4, 5, 6, 7, 8] → quartile cuts at 2, 4, 6
    const bin = quartileBins([1, 2, 3, 4, 5, 6, 7, 8])
    expect(bin(0)).toBe(0)
    expect(bin(1)).toBe(1)
    expect(bin(2)).toBe(1)
    expect(bin(4)).toBe(2)
    expect(bin(6)).toBe(3)
    expect(bin(8)).toBe(4)
  })
  it('handles all-zero history (everything bins to 0)', () => {
    const bin = quartileBins([])
    expect(bin(0)).toBe(0)
    expect(bin(5)).toBe(0)
  })
  it('handles single-value history', () => {
    const bin = quartileBins([3])
    expect(bin(0)).toBe(0)
    expect(bin(3)).toBe(4)
  })
})

describe('yearRangeFromHistory', () => {
  it('returns oldest..newest year from ISO timestamps', () => {
    expect(yearRangeFromHistory([
      '2024-06-01T00:00:00Z',
      '2026-02-15T00:00:00Z'
    ])).toEqual({ minYear: 2024, maxYear: 2026 })
  })
  it('falls back to current year when history is empty', () => {
    const now = new Date().getFullYear()
    expect(yearRangeFromHistory([])).toEqual({ minYear: now, maxYear: now })
  })
})

describe('formatRelativeTime', () => {
  it('returns "just now" for sub-minute', () => {
    const now = Date.now()
    expect(formatRelativeTime(now - 5_000, now)).toBe('just now')
  })
  it('returns minutes', () => {
    const now = Date.now()
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
  })
  it('returns hours', () => {
    const now = Date.now()
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2h ago')
  })
  it('returns days', () => {
    const now = Date.now()
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3d ago')
  })
})

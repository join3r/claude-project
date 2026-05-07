// tests/palette-fuzzy.test.ts
import { describe, it, expect } from 'vitest'
import { fuzzyMatch } from '../src/renderer/palette/fuzzy'

describe('fuzzyMatch', () => {
  it('returns null when target does not contain all query chars in order', () => {
    expect(fuzzyMatch('abc', 'cab')).toBeNull()
  })

  it('returns a match when target is a subsequence of query', () => {
    const m = fuzzyMatch('opn', 'open project')
    expect(m).not.toBeNull()
    expect(m!.spans.length).toBeGreaterThan(0)
  })

  it('scores prefix match higher than midword', () => {
    const prefix = fuzzyMatch('set', 'settings')!
    const mid = fuzzyMatch('set', 'unset all')!
    expect(prefix.score).toBeGreaterThan(mid.score)
  })

  it('scores contiguous match higher than split', () => {
    const contig = fuzzyMatch('depl', 'deploy')!
    const split = fuzzyMatch('depl', 'd_e_p_l_oy')!
    expect(contig.score).toBeGreaterThan(split.score)
  })

  it('scores word-boundary match higher than within-word', () => {
    const wb = fuzzyMatch('ns', 'new session')!
    const ww = fuzzyMatch('ns', 'consumes')!
    expect(wb.score).toBeGreaterThan(ww.score)
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatch('SET', 'settings')).not.toBeNull()
    expect(fuzzyMatch('set', 'SETTINGS')).not.toBeNull()
  })

  it('returns spans covering matched indices in order', () => {
    const m = fuzzyMatch('abc', 'a-b-c')!
    expect(m.spans).toEqual([[0, 1], [2, 3], [4, 5]])
  })

  it('merges adjacent matched indices into a single span', () => {
    const m = fuzzyMatch('abc', 'abc')!
    expect(m.spans).toEqual([[0, 3]])
  })
})

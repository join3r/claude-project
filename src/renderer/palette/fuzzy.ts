// src/renderer/palette/fuzzy.ts
export interface FuzzyMatch {
  score: number
  spans: [number, number][]
}

const CONTIGUOUS_BONUS = 8
const WORD_BOUNDARY_BONUS = 6
const PREFIX_BONUS = 12
const BASE = 2

function isWordBoundary(target: string, idx: number): boolean {
  if (idx === 0) return true
  const prev = target[idx - 1]
  return prev === ' ' || prev === '-' || prev === '_' || prev === '.' || prev === '/'
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, spans: [] }
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  const indices: number[] = []
  let ti = 0
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti)
    if (found === -1) return null
    indices.push(found)
    ti = found + 1
  }

  let score = 0
  let prev = -2
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    score += BASE
    if (idx === prev + 1) score += CONTIGUOUS_BONUS
    if (isWordBoundary(t, idx)) score += WORD_BOUNDARY_BONUS
    prev = idx
  }
  if (indices[0] === 0) score += PREFIX_BONUS

  const spans: [number, number][] = []
  let start = indices[0]
  let end = indices[0] + 1
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === end) {
      end++
    } else {
      spans.push([start, end])
      start = indices[i]
      end = indices[i] + 1
    }
  }
  spans.push([start, end])

  return { score, spans }
}

export const FUZZY_SCORE_FLOOR = 4

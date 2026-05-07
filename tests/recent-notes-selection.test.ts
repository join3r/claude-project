import { describe, it, expect } from 'vitest'
import { selectRecentNotes } from '../src/renderer/hooks/useAppState'
import type { ProjectNote } from '../src/shared/types'

function note(id: string, updatedAt: number, name = id, content = ''): ProjectNote {
  return { id, name, content, createdAt: 0, updatedAt }
}

describe('selectRecentNotes', () => {
  it('returns top N by updatedAt descending', () => {
    const notes = { p1: [note('a', 100), note('b', 300), note('c', 200)] }
    expect(selectRecentNotes(notes, 'p1', 8).map(n => n.id)).toEqual(['b', 'c', 'a'])
  })
  it('respects the limit', () => {
    const notes = { p1: [note('a', 1), note('b', 2), note('c', 3)] }
    expect(selectRecentNotes(notes, 'p1', 2).map(n => n.id)).toEqual(['c', 'b'])
  })
  it('returns empty array for unknown project id', () => {
    expect(selectRecentNotes({}, 'nope', 8)).toEqual([])
  })
  it('does not mutate the input list', () => {
    const list = [note('a', 1), note('b', 2)]
    const notes = { p1: list }
    selectRecentNotes(notes, 'p1', 8)
    expect(list.map(n => n.id)).toEqual(['a', 'b'])
  })
  it('returns empty when projectId has empty array', () => {
    expect(selectRecentNotes({ p1: [] }, 'p1', 8)).toEqual([])
  })
})

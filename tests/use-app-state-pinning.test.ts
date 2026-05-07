import { describe, it, expect } from 'vitest'
import { applyTabPinned } from '../src/renderer/hooks/useAppState'
import type { ProjectsData } from '../src/shared/types'

function seed(): ProjectsData {
  return {
    projects: [
      {
        id: 'p1',
        name: 'P1',
        tasks: [
          {
            id: 't1',
            name: 'T1',
            tabs: {
              left: [
                { id: 'tab-a', type: 'terminal', title: 'a' },
                { id: 'tab-b', type: 'terminal', title: 'b' }
              ],
              right: []
            },
            activeTab: { left: 'tab-a', right: null },
            splitOpen: false,
            splitRatio: 0.5
          }
        ]
      } as any
    ],
    folders: [],
    rootOrder: ['p1']
  }
}

describe('applyTabPinned', () => {
  it('sets pinned=true on the matching tab', () => {
    const next = applyTabPinned(seed(), 'p1', 't1', 'left', 'tab-a', true)
    const tab = next.projects[0].tasks[0].tabs.left.find(t => t.id === 'tab-a')!
    expect(tab.pinned).toBe(true)
  })
  it('sets pinned=false', () => {
    const start = seed()
    start.projects[0].tasks[0].tabs.left[0].pinned = true
    const next = applyTabPinned(start, 'p1', 't1', 'left', 'tab-a', false)
    const tab = next.projects[0].tasks[0].tabs.left.find(t => t.id === 'tab-a')!
    expect(tab.pinned).toBe(false)
  })
  it('does not mutate other tabs', () => {
    const next = applyTabPinned(seed(), 'p1', 't1', 'left', 'tab-a', true)
    const other = next.projects[0].tasks[0].tabs.left.find(t => t.id === 'tab-b')!
    expect(other.pinned).toBeUndefined()
  })
  it('is a no-op when project/task/tab is not found', () => {
    const before = seed()
    const next = applyTabPinned(before, 'nope', 't1', 'left', 'tab-a', true)
    expect(next).toEqual(before)
  })
})

import { describe, expect, it } from 'vitest'
import { moveTaskTab } from '../src/renderer/tabMove'
import type { Tab, TaskViewState } from '../src/shared/types'

function makeTab(id: string): Tab {
  return {
    id,
    type: 'terminal',
    title: id
  }
}

function makeState(left: string | null, right: string | null): TaskViewState {
  return {
    activeTab: { left, right },
    splitOpen: true,
    splitRatio: 0.5
  }
}

describe('moveTaskTab', () => {
  it('reorders tabs forward within the left pane', () => {
    const result = moveTaskTab({
      tabs: {
        left: [makeTab('a'), makeTab('b'), makeTab('c')],
        right: []
      },
      taskState: makeState('b', null),
      fromPane: 'left',
      tabId: 'a',
      toPane: 'left',
      toIndex: 3
    })

    expect(result.moved).toBe(true)
    expect(result.tabs.left.map((tab) => tab.id)).toEqual(['b', 'c', 'a'])
    expect(result.taskState.activeTab.left).toBe('b')
  })

  it('reorders tabs backward within the right pane', () => {
    const result = moveTaskTab({
      tabs: {
        left: [],
        right: [makeTab('a'), makeTab('b'), makeTab('c')]
      },
      taskState: makeState(null, 'c'),
      fromPane: 'right',
      tabId: 'c',
      toPane: 'right',
      toIndex: 0
    })

    expect(result.moved).toBe(true)
    expect(result.tabs.right.map((tab) => tab.id)).toEqual(['c', 'a', 'b'])
    expect(result.taskState.activeTab.right).toBe('c')
  })

  it('treats adjacent same-pane drops as no-ops', () => {
    const result = moveTaskTab({
      tabs: {
        left: [makeTab('a'), makeTab('b'), makeTab('c')],
        right: []
      },
      taskState: makeState('b', null),
      fromPane: 'left',
      tabId: 'b',
      toPane: 'left',
      toIndex: 2
    })

    expect(result.moved).toBe(false)
    expect(result.tabs.left.map((tab) => tab.id)).toEqual(['a', 'b', 'c'])
  })

  it('moves a tab from left to right at the start of the pane', () => {
    const result = moveTaskTab({
      tabs: {
        left: [makeTab('a'), makeTab('b')],
        right: [makeTab('x'), makeTab('y')]
      },
      taskState: makeState('a', 'x'),
      fromPane: 'left',
      tabId: 'b',
      toPane: 'right',
      toIndex: 0
    })

    expect(result.tabs.left.map((tab) => tab.id)).toEqual(['a'])
    expect(result.tabs.right.map((tab) => tab.id)).toEqual(['b', 'x', 'y'])
    expect(result.taskState.activeTab.left).toBe('a')
    expect(result.taskState.activeTab.right).toBe('b')
  })

  it('moves a tab from left to right into the middle of the pane', () => {
    const result = moveTaskTab({
      tabs: {
        left: [makeTab('a'), makeTab('b')],
        right: [makeTab('x'), makeTab('y')]
      },
      taskState: makeState('a', 'x'),
      fromPane: 'left',
      tabId: 'b',
      toPane: 'right',
      toIndex: 1
    })

    expect(result.tabs.right.map((tab) => tab.id)).toEqual(['x', 'b', 'y'])
    expect(result.taskState.activeTab.right).toBe('b')
  })

  it('moves a tab from right to left at the end of the pane', () => {
    const result = moveTaskTab({
      tabs: {
        left: [makeTab('a'), makeTab('b')],
        right: [makeTab('x'), makeTab('y')]
      },
      taskState: makeState('a', 'y'),
      fromPane: 'right',
      tabId: 'x',
      toPane: 'left',
      toIndex: 2
    })

    expect(result.tabs.left.map((tab) => tab.id)).toEqual(['a', 'b', 'x'])
    expect(result.tabs.right.map((tab) => tab.id)).toEqual(['y'])
    expect(result.taskState.activeTab.left).toBe('x')
    expect(result.taskState.activeTab.right).toBe('y')
  })

  it('falls back to the last remaining tab when moving the active tab out of a pane', () => {
    const result = moveTaskTab({
      tabs: {
        left: [makeTab('a'), makeTab('b'), makeTab('c')],
        right: [makeTab('x')]
      },
      taskState: makeState('b', 'x'),
      fromPane: 'left',
      tabId: 'b',
      toPane: 'right',
      toIndex: 1
    })

    expect(result.tabs.left.map((tab) => tab.id)).toEqual(['a', 'c'])
    expect(result.taskState.activeTab.left).toBe('c')
    expect(result.taskState.activeTab.right).toBe('b')
  })

  it('preserves the source active tab when moving an inactive tab away', () => {
    const result = moveTaskTab({
      tabs: {
        left: [makeTab('a'), makeTab('b')],
        right: [makeTab('x')]
      },
      taskState: makeState('a', 'x'),
      fromPane: 'left',
      tabId: 'b',
      toPane: 'right',
      toIndex: 1
    })

    expect(result.taskState.activeTab.left).toBe('a')
    expect(result.taskState.activeTab.right).toBe('b')
  })

  it('sets the source active tab to null when moving the last tab away', () => {
    const result = moveTaskTab({
      tabs: {
        left: [makeTab('a')],
        right: [makeTab('x')]
      },
      taskState: makeState('a', 'x'),
      fromPane: 'left',
      tabId: 'a',
      toPane: 'right',
      toIndex: 1
    })

    expect(result.tabs.left).toEqual([])
    expect(result.taskState.activeTab.left).toBeNull()
    expect(result.taskState.activeTab.right).toBe('a')
  })
})

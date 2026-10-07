import { describe, expect, it } from 'vitest'
import {
  MIN_PANE_WIDTH,
  addTabToPane,
  dragDivider,
  findTabLocation,
  moveTabInTask,
  normalizeTaskLayout,
  normalizeWidths,
  patchTabInTask,
  removeTabFromTask,
  setActiveTabInTask,
  setPaneWidths,
  showsTabBars,
  splitTabRight,
  withPaneRow
} from '../src/shared/panes'
import type { Tab, Task, TaskPane } from '../src/shared/types'

const tab = (id: string, type: Tab['type'] = 'terminal'): Tab => ({ id, type, title: id })

/** A task from pane specs: tab ids per pane, the active one, and widths. */
function task(spec: Array<{ tabs: string[]; active?: string; width?: number }>, extra: Partial<Task> = {}): Task {
  const panes: TaskPane[] = spec.map(pane => ({
    tabs: pane.tabs.map(id => tab(id, id.startsWith('agent') ? 'claude' : 'terminal')),
    activeTabId: pane.active ?? pane.tabs[pane.tabs.length - 1],
    width: pane.width ?? 1 / spec.length
  }))
  return { id: 't', name: 't', panes, ...extra }
}

const ids = (t: Task) => t.panes.map(pane => pane.tabs.map(candidate => candidate.id))
const widths = (t: Task) => t.panes.map(pane => Number(pane.width.toFixed(6)))
const actives = (t: Task) => t.panes.map(pane => pane.activeTabId)

describe('normalizeWidths', () => {
  it('scales shares to add up to 1', () => {
    expect(normalizeWidths([1, 1, 2])).toEqual([0.25, 0.25, 0.5])
    expect(normalizeWidths([])).toEqual([])
  })

  it('gives broken widths the mean of the valid ones', () => {
    expect(normalizeWidths([0.5, Number.NaN, 0.5])).toEqual([1 / 3, 1 / 3, 1 / 3])
    expect(normalizeWidths([-1, 0])).toEqual([0.5, 0.5])
  })
})

describe('withPaneRow / normalizeTaskLayout', () => {
  it('closes empty panes and lets the rest share their space', () => {
    const next = withPaneRow(task([]), [
      { tabs: [tab('a')], activeTabId: 'a', width: 0.25 },
      { tabs: [], activeTabId: 'gone', width: 0.5 },
      { tabs: [tab('b')], activeTabId: 'b', width: 0.25 }
    ])
    expect(ids(next)).toEqual([['a'], ['b']])
    expect(widths(next)).toEqual([0.5, 0.5])
  })

  it('repairs active and main tabs', () => {
    const broken = task([{ tabs: ['x', 'agent'], active: 'nope', width: 3 }], { mainTabId: 'missing' })
    const fixed = normalizeTaskLayout(broken)
    expect(actives(fixed)).toEqual(['agent'])
    expect(widths(fixed)).toEqual([1])
    expect(fixed.mainTabId).toBe('agent')
  })

  it('is the identity on a valid layout, and idempotent', () => {
    const valid = task([{ tabs: ['agent'], width: 0.4 }, { tabs: ['b', 'c'], active: 'b', width: 0.6 }], { mainTabId: 'agent' })
    expect(normalizeTaskLayout(valid)).toBe(valid)
    const broken = { ...valid, panes: [...valid.panes, { tabs: [], activeTabId: '', width: 0.2 }] }
    const once = normalizeTaskLayout(broken)
    expect(once).not.toBe(broken)
    expect(normalizeTaskLayout(once)).toBe(once)
  })

  it('survives malformed stored panes', () => {
    const raw = { id: 't', name: 't', panes: [null, { tabs: 'x' }, { tabs: [tab('a'), null], activeTabId: 'a', width: 1 }] } as unknown as Task
    expect(ids(normalizeTaskLayout(raw))).toEqual([['a']])
    expect(normalizeTaskLayout({ id: 't', name: 't' } as unknown as Task).panes).toEqual([])
  })
})

describe('tab bar rule', () => {
  it('shows bars from the second tab on', () => {
    expect(showsTabBars(task([]))).toBe(false)
    expect(showsTabBars(task([{ tabs: ['a'] }]))).toBe(false)
    expect(showsTabBars(task([{ tabs: ['a', 'b'] }]))).toBe(true)
    expect(showsTabBars(task([{ tabs: ['a'] }, { tabs: ['b'] }]))).toBe(true)
  })
})

describe('adding, activating and removing tabs', () => {
  it('opens the first pane of an empty task', () => {
    const next = addTabToPane(task([]), 3, tab('agent', 'claude'))
    expect(next.panes).toEqual([{ tabs: [tab('agent', 'claude')], activeTabId: 'agent', width: 1 }])
    expect(next.mainTabId).toBe('agent')
  })

  it('adds into a clamped pane at an index, activating unless told not to', () => {
    const base = task([{ tabs: ['a'] }, { tabs: ['b'] }])
    expect(ids(addTabToPane(base, 9, tab('z'), { index: 0 }))).toEqual([['a'], ['z', 'b']])
    expect(actives(addTabToPane(base, 0, tab('z')))).toEqual(['z', 'b'])
    expect(actives(addTabToPane(base, 0, tab('z'), { activate: false }))).toEqual(['a', 'b'])
    const once = addTabToPane(base, 0, tab('z'))
    expect(addTabToPane(once, 1, tab('z'))).toBe(once)
  })

  it('auto-closes a pane when its last tab closes', () => {
    const base = task([{ tabs: ['a'], width: 0.2 }, { tabs: ['b'], width: 0.3 }, { tabs: ['c'], width: 0.5 }])
    const next = removeTabFromTask(base, 'b')
    expect(ids(next)).toEqual([['a'], ['c']])
    expect(widths(next)).toEqual([Number((0.2 / 0.7).toFixed(6)), Number((0.5 / 0.7).toFixed(6))])
    expect(removeTabFromTask(base, 'missing')).toBe(base)
  })

  it('moves the active tab to the last one left when the active tab closes', () => {
    const next = removeTabFromTask(task([{ tabs: ['a', 'b', 'c'], active: 'b' }]), 'b')
    expect(actives(next)).toEqual(['c'])
  })

  it('clears the main tab with the last tab, leaving the prompt box', () => {
    const next = removeTabFromTask(task([{ tabs: ['agent'] }], { mainTabId: 'agent' }), 'agent')
    expect(next.panes).toEqual([])
    expect(next.mainTabId).toBeUndefined()
  })

  it('activates a tab in its own pane only', () => {
    const base = task([{ tabs: ['a', 'b'], active: 'b' }, { tabs: ['c'] }])
    expect(actives(setActiveTabInTask(base, 'a'))).toEqual(['a', 'c'])
    expect(setActiveTabInTask(base, 'b')).toBe(base)
    expect(setActiveTabInTask(base, 'missing')).toBe(base)
  })

  it('patches a tab in place', () => {
    const base = task([{ tabs: ['a'] }, { tabs: ['b'] }])
    const next = patchTabInTask(base, 'b', { url: 'http://x' })
    expect(next.panes[1].tabs[0].url).toBe('http://x')
    expect(next.panes[0]).toBe(base.panes[0])
    expect(patchTabInTask(next, 'b', { url: 'http://x' })).toBe(next)
  })

  it('finds where a tab is', () => {
    expect(findTabLocation(task([{ tabs: ['a'] }, { tabs: ['b', 'c'] }]), 'c')).toEqual({ pane: 1, index: 1 })
    expect(findTabLocation(task([{ tabs: ['a'] }]), 'x')).toBeNull()
  })
})

describe('moving tabs', () => {
  it('reorders within a pane (index counts the list before the move)', () => {
    const base = task([{ tabs: ['a', 'b', 'c'], active: 'b' }])
    expect(ids(moveTabInTask(base, 'a', { kind: 'tab', pane: 0, index: 2 }))).toEqual([['b', 'a', 'c']])
    expect(ids(moveTabInTask(base, 'c', { kind: 'tab', pane: 0, index: 0 }))).toEqual([['c', 'a', 'b']])
    expect(moveTabInTask(base, 'b', { kind: 'tab', pane: 0, index: 2 })).toBe(base)
  })

  it('moves to another pane and activates it there', () => {
    const base = task([{ tabs: ['a', 'b'], active: 'a' }, { tabs: ['c'] }])
    const next = moveTabInTask(base, 'a', { kind: 'tab', pane: 1, index: 0 })
    expect(ids(next)).toEqual([['b'], ['a', 'c']])
    expect(actives(next)).toEqual(['b', 'a'])
  })

  it('closes the pane a moved tab leaves empty', () => {
    const base = task([{ tabs: ['a'] }, { tabs: ['b'] }, { tabs: ['c'] }])
    const next = moveTabInTask(base, 'b', { kind: 'tab', pane: 2, index: 1 })
    expect(ids(next)).toEqual([['a'], ['c', 'b']])
    expect(widths(next)).toEqual([0.5, 0.5])
  })

  it('splits a pane in half on either side', () => {
    const base = task([{ tabs: ['a', 'b'], width: 0.6 }, { tabs: ['c'], width: 0.4 }])
    const right = moveTabInTask(base, 'b', { kind: 'split', pane: 0, side: 'right' })
    expect(ids(right)).toEqual([['a'], ['b'], ['c']])
    expect(widths(right)).toEqual([0.3, 0.3, 0.4])
    const left = moveTabInTask(base, 'b', { kind: 'split', pane: 1, side: 'left' })
    expect(ids(left)).toEqual([['a'], ['b'], ['c']])
    expect(widths(left)).toEqual([0.6, 0.2, 0.2])
  })

  it('splitting off a pane’s only tab beside itself changes nothing', () => {
    const base = task([{ tabs: ['a'] }, { tabs: ['b'] }])
    expect(moveTabInTask(base, 'a', { kind: 'split', pane: 0, side: 'right' })).toBe(base)
    expect(splitTabRight(base, 'b')).toBe(base)
  })

  it('moves a pane’s only tab to the far side, closing its old pane', () => {
    const base = task([{ tabs: ['a'], width: 0.5 }, { tabs: ['b'], width: 0.25 }, { tabs: ['c'], width: 0.25 }])
    const next = moveTabInTask(base, 'a', { kind: 'split', pane: 2, side: 'right' })
    expect(ids(next)).toEqual([['b'], ['c'], ['a']])
    expect(widths(next)).toEqual([0.5, 0.25, 0.25])
  })

  it('lets the main tab move like any other tab', () => {
    const base = task([{ tabs: ['agent', 'b'] }], { mainTabId: 'agent' })
    const next = splitTabRight(base, 'agent')
    expect(ids(next)).toEqual([['b'], ['agent']])
    expect(next.mainTabId).toBe('agent')
  })

  it('ignores unknown tabs and panes', () => {
    const base = task([{ tabs: ['a', 'b'] }])
    expect(moveTabInTask(base, 'x', { kind: 'tab', pane: 0, index: 0 })).toBe(base)
    expect(moveTabInTask(base, 'a', { kind: 'split', pane: 4, side: 'left' })).toBe(base)
  })
})

describe('resizing', () => {
  it('moves only the divider’s two panes', () => {
    expect(dragDivider([0.25, 0.25, 0.5], 1, 0.4).map(w => Number(w.toFixed(6)))).toEqual([0.25, 0.15, 0.6])
  })

  it('keeps both panes at least the minimum width', () => {
    const next = dragDivider([0.5, 0.5], 0, 0.01)
    expect(next[0]).toBe(MIN_PANE_WIDTH)
    expect(next[1]).toBeCloseTo(1 - MIN_PANE_WIDTH)
    expect(dragDivider([0.5, 0.5], 0, 2)[1]).toBeCloseTo(MIN_PANE_WIDTH)
  })

  it('ignores a divider that does not exist', () => {
    expect(dragDivider([1], 0, 0.3)).toEqual([1])
  })

  it('stores normalised widths, and is a no-op when nothing changes', () => {
    const base = task([{ tabs: ['a'] }, { tabs: ['b'] }])
    const next = setPaneWidths(base, [3, 1])
    expect(widths(next)).toEqual([0.75, 0.25])
    expect(setPaneWidths(next, [0.75, 0.25])).toBe(next)
    expect(setPaneWidths(base, [1])).toBe(base)
  })
})

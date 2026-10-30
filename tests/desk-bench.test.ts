import { beforeEach, describe, expect, it } from 'vitest'
import {
  benchCurrentItem,
  benchDividerShown,
  benchGridColumns,
  benchNewTabPane,
  benchPanes,
  benchTabClosable,
  benchTabOfType,
  conversationTabId,
  dragBenchDivider
} from '../src/renderer/components/desk/benchLayout'
import { closeBenchRun, getBench, MIN_BENCH_HEIGHT, openBench, openBenchRun, setBench, toggleBench, toggleBenchView } from '../src/renderer/components/desk/benchState'
import type { Tab, TabType, Task, TaskPane } from '../src/shared/types'

function tab(id: string, type: TabType): Tab {
  return { id, type, title: id }
}

function pane(tabs: Tab[], activeTabId = tabs[0]?.id ?? '', width = 1): TaskPane {
  return { tabs, activeTabId, width }
}

function task(panes: TaskPane[]): Task {
  return { id: 't', name: 't', panes }
}

describe('the conversation and the Bench', () => {
  it('takes the first chat tab, in pane order, as the conversation', () => {
    const t = task([pane([tab('term', 'terminal')]), pane([tab('chat', 'claude-chat'), tab('chat2', 'claude-chat')])])
    expect(conversationTabId(t)).toBe('chat')
    expect(conversationTabId(task([pane([tab('cc', 'claude')])]))).toBeNull()
  })

  it('leaves the conversation out of the Bench and shows another tab where it was active', () => {
    const t = task([pane([tab('chat', 'claude-chat'), tab('term', 'terminal'), tab('web', 'browser')], 'chat')])
    const [bench] = benchPanes(t, 'chat')
    expect(bench.tabs.map(x => x.id)).toEqual(['term', 'web'])
    expect(bench.activeTabId).toBe('term')
    expect(bench.hidden).toBe(false)
  })

  it('keeps the active tab when it is not the conversation', () => {
    const t = task([pane([tab('chat', 'claude-chat'), tab('term', 'terminal'), tab('web', 'browser')], 'web')])
    expect(benchPanes(t, 'chat')[0].activeTabId).toBe('web')
  })

  it('hides a pane holding only the conversation, and the dividers beside it', () => {
    const t = task([pane([tab('chat', 'claude-chat')], 'chat', 2), pane([tab('a', 'terminal')]), pane([tab('b', 'browser')])])
    const bench = benchPanes(t, 'chat')
    expect(bench.map(p => p.hidden)).toEqual([true, false, false])
    expect(benchGridColumns([2, 1, 1], bench)).toBe('0px 0px minmax(0, 1fr) 3px minmax(0, 1fr)')
    expect(benchDividerShown(bench, 0)).toBe(false)
    expect(benchDividerShown(bench, 1)).toBe(true)
  })

  it('keeps the width for the conversation when the Bench shows no pane', () => {
    const t = task([pane([tab('chat', 'claude-chat')], 'chat')])
    expect(benchGridColumns([1], benchPanes(t, 'chat'))).toBe('minmax(0, 1fr)')
  })

  it('without a conversation shows every pane', () => {
    const t = task([pane([tab('a', 'terminal')]), pane([tab('b', 'browser')])])
    expect(benchGridColumns([1, 1], benchPanes(t, null))).toBe('minmax(0, 1fr) 3px minmax(0, 1fr)')
  })

  it('drags a divider as a share of the panes the Bench shows', () => {
    const t = task([pane([tab('chat', 'claude-chat')], 'chat', 0.5), pane([tab('a', 'terminal')], 'a', 0.25), pane([tab('b', 'browser')], 'b', 0.25)])
    const bench = benchPanes(t, 'chat')
    // Pointer at a quarter of the Bench: the shown panes split 1:3, the hidden one keeps its width.
    const next = dragBenchDivider([0.5, 0.25, 0.25], bench, 1, 0.25)
    expect(next[0]).toBe(0.5)
    expect(next[1]).toBeCloseTo(0.125)
    expect(next[2]).toBeCloseTo(0.375)
  })
})

describe('the Bench strip', () => {
  const t = task([
    pane([tab('chat', 'claude-chat'), tab('t1', 'terminal'), tab('w1', 'browser')], 'chat'),
    pane([tab('t2', 'terminal')])
  ])
  const bench = benchPanes(t, 'chat')

  it('picks the shown tab of a type before the first one', () => {
    expect(benchTabOfType(bench, 'terminal')).toBe('t1')
    const other = benchPanes(task([pane([tab('chat', 'claude-chat'), tab('t1', 'terminal')], 'chat'), pane([tab('w', 'browser'), tab('t2', 'terminal')], 't2')]), 'chat')
    expect(benchTabOfType(other, 'terminal')).toBe('t1')
    expect(benchTabOfType(other, 'browser')).toBe('w')
    expect(benchTabOfType(other, 'note')).toBeNull()
  })

  it('opens a new tab in the focused pane, or the first one the Bench shows', () => {
    expect(benchNewTabPane(bench, 1)).toBe(1)
    const hiddenFirst = benchPanes(task([pane([tab('chat', 'claude-chat')], 'chat'), pane([tab('a', 'terminal')])]), 'chat')
    expect(benchNewTabPane(hiddenFirst, 0)).toBe(1)
    expect(benchNewTabPane(benchPanes(task([pane([tab('chat', 'claude-chat')], 'chat')]), 'chat'), 0)).toBe(0)
  })

  it('lights the panel, or the type of the tab the focused pane shows', () => {
    expect(benchCurrentItem(bench, 'changes', 0)).toBe('changes')
    expect(benchCurrentItem(bench, 'panes', 0)).toBe('terminal')
    const web = benchPanes(task([pane([tab('chat', 'claude-chat'), tab('w', 'browser')], 'chat')]), 'chat')
    expect(benchCurrentItem(web, 'panes', 0)).toBe('browser')
    const editor = benchPanes(task([pane([tab('chat', 'claude-chat'), tab('e', 'editor')], 'e')]), 'chat')
    expect(benchCurrentItem(editor, 'panes', 0)).toBeNull()
  })
})

describe('Bench state', () => {
  let n = 0
  let id = ''
  beforeEach(() => { id = `task-${n++}` })

  it('starts closed and opens on a view', () => {
    expect(getBench(id).open).toBe(false)
    openBench(id, 'changes')
    expect(getBench(id)).toMatchObject({ open: true, view: 'changes' })
    toggleBench(id)
    expect(getBench(id)).toMatchObject({ open: false, view: 'changes' })
  })

  it('toggles a panel shut only while it shows', () => {
    toggleBenchView(id, 'files')
    expect(getBench(id)).toMatchObject({ open: true, view: 'files' })
    toggleBenchView(id, 'notes')
    expect(getBench(id)).toMatchObject({ open: true, view: 'notes' })
    toggleBenchView(id, 'notes')
    expect(getBench(id).open).toBe(false)
  })

  it('holds a run log until its × closes it, back on the panes', () => {
    const dev = { projectId: 'p', streamId: 's', commandId: 'dev' }
    openBenchRun(id, dev)
    expect(getBench(id)).toMatchObject({ open: true, view: 'run', run: dev })
    openBench(id, 'files')
    expect(getBench(id)).toMatchObject({ view: 'files', run: dev })
    closeBenchRun(id)
    expect(getBench(id)).toMatchObject({ view: 'files', run: null })
    openBenchRun(id, dev)
    closeBenchRun(id)
    expect(getBench(id)).toMatchObject({ open: true, view: 'panes', run: null })
    expect(benchCurrentItem([], 'run', 0)).toBeNull()
  })

  it('keeps a height of at least the minimum', () => {
    setBench(id, { height: 10 })
    expect(getBench(id).height).toBe(MIN_BENCH_HEIGHT)
  })
})

describe('⌘W in the desk', () => {
  const t = task([pane([tab('chat', 'claude-chat'), tab('term', 'terminal')], 'term')])
  const bench = (open: boolean, view: 'panes' | 'files' | 'run' = 'panes', run: unknown = null) => ({ open, view, run })

  it('closes a Bench tab only while the Bench shows it', () => {
    expect(benchTabClosable(t, bench(true), 'term')).toBe(true)
    expect(benchTabClosable(t, bench(false), 'term')).toBe(false)
    expect(benchTabClosable(t, bench(true, 'files'), 'term')).toBe(false)
    expect(benchTabClosable(t, bench(true, 'run', { commandId: 'dev' }), 'term')).toBe(false)
    expect(benchTabClosable(t, bench(true, 'run', null), 'term')).toBe(true)
  })

  it('never closes the conversation', () => {
    expect(benchTabClosable(t, bench(true), 'chat')).toBe(false)
  })

  it('closes from the full-size Bench of a task with no chat', () => {
    const terminals = task([pane([tab('a', 'terminal'), tab('b', 'terminal')], 'b')])
    expect(benchTabClosable(terminals, bench(false), 'b')).toBe(true)
  })
})

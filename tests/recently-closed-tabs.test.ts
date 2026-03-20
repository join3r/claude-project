import { describe, expect, it } from 'vitest'
import {
  pushRecentlyClosedTab,
  shiftRestorableClosedTab,
  type RecentlyClosedTab
} from '../src/renderer/recentlyClosedTabs'
import type { Project, Tab } from '../src/shared/types'

function makeTab(id: string): Tab {
  return {
    id,
    type: 'terminal',
    title: id
  }
}

function makeProject(tabIds: string[] = []): Project {
  return {
    id: 'project-1',
    name: 'Project',
    directory: '/tmp/project',
    tasks: [{
      id: 'task-1',
      name: 'Task',
      tabs: {
        left: tabIds.map(makeTab),
        right: []
      },
      activeTab: { left: tabIds[tabIds.length - 1] ?? null, right: null },
      splitOpen: false,
      splitRatio: 0.5
    }]
  }
}

function makeEntry(id: string, projectId = 'project-1', taskId = 'task-1'): RecentlyClosedTab {
  return {
    projectId,
    taskId,
    pane: 'left',
    index: 0,
    tab: makeTab(id)
  }
}

describe('recently closed tabs', () => {
  it('keeps the newest entries and evicts overflow', () => {
    const result = pushRecentlyClosedTab(
      [makeEntry('older'), makeEntry('oldest')],
      makeEntry('newest'),
      2
    )

    expect(result.history.map(entry => entry.tab.id)).toEqual(['newest', 'older'])
    expect(result.evicted.map(entry => entry.tab.id)).toEqual(['oldest'])
  })

  it('skips stale entries until it finds a restorable tab', () => {
    const history = [
      makeEntry('missing-project', 'missing-project'),
      makeEntry('already-open'),
      makeEntry('restorable')
    ]

    const result = shiftRestorableClosedTab(history, [makeProject(['already-open'])])

    expect(result.entry?.tab.id).toBe('restorable')
    expect(result.stale.map(entry => entry.tab.id)).toEqual(['missing-project', 'already-open'])
    expect(result.history).toEqual([])
  })

  it('keeps older entries after consuming the first restorable tab', () => {
    const history = [makeEntry('first'), makeEntry('second')]

    const result = shiftRestorableClosedTab(history, [makeProject()])

    expect(result.entry?.tab.id).toBe('first')
    expect(result.history.map(entry => entry.tab.id)).toEqual(['second'])
    expect(result.stale).toEqual([])
  })
})

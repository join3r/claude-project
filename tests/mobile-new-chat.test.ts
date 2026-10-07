import { describe, expect, it } from 'vitest'
import { addChatTab } from '../src/main/mobile/new-chat'
import { type Project, type ProjectsData } from '../src/shared/types'
import { findTaskInProject, paneTabs } from '../src/shared/streams'
import { fixtureProject } from './helpers/streams-fixtures'

function data(extra: Partial<Project> = {}): ProjectsData {
  return {
    projects: [fixtureProject({
      id: 'p1', name: 'api', directory: '/src/api', ...extra,
      tasks: [{
        id: 't1', name: 'fix-auth',
        tabs: { left: [{ id: 'tab-term', type: 'terminal', title: 'zsh' }], right: [{ id: 'tab-r', type: 'browser', title: 'Browser' }] },
        activeTab: { left: 'tab-term', right: 'tab-r' }
      }]
    })],
    tags: [], projectOrder: ['p1'], pinnedItems: []
  }
}

function counter(): () => string {
  let n = 0
  return () => `id-${++n}`
}

describe('addChatTab (SPEC.md §8.2)', () => {
  it('appends a claude-chat tab with fresh ids to the left pane and leaves the rest alone', () => {
    const before = data()
    const result = addChatTab(before, 't1', counter())
    expect(result).toMatchObject({ ok: true, tabId: 'id-1' })
    if (!result.ok) return
    const task = findTaskInProject(result.data.projects[0], 't1')!
    const old = findTaskInProject(before.projects[0], 't1')!
    expect(paneTabs(task, 'left')).toEqual([
      { id: 'tab-term', type: 'terminal', title: 'zsh' },
      { id: 'id-1', type: 'claude-chat', title: 'Claude', sessionId: 'id-2' }
    ])
    expect(paneTabs(task, 'right')).toBe(paneTabs(old, 'right'))
    // The desktop's own view isn't switched to the new tab.
    expect(task.panes.map(pane => pane.activeTabId)).toEqual(['tab-term', 'tab-r'])
    // The input is not mutated.
    expect(paneTabs(old, 'left')).toHaveLength(1)
  })

  it('refuses unknown tasks, hidden projects and shell-command projects', () => {
    expect(addChatTab(data(), 'nope')).toMatchObject({ ok: false, code: 'not-found' })
    expect(addChatTab(data({ hideFromMobile: true }), 't1')).toMatchObject({ ok: false, code: 'not-found' })
    expect(addChatTab(data({ shellCommand: { command: 'npm run dev' } }), 't1')).toMatchObject({ ok: false, code: 'unsupported' })
  })
})

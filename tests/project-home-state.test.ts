import { describe, expect, it } from 'vitest'
import { projectHomeSummary } from '../src/renderer/components/projectHomeState'
import type { Tab } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

const NOW = new Date('2026-10-07T12:00:00').getTime()

const tab = (id: string, type: Tab['type']): Tab => ({ id, type, title: id })

describe('projectHomeSummary', () => {
  it('counts open tasks, how many need you or work, and tasks by agent in a fixed order', () => {
    const project = fixtureProject({
      id: 'p',
      tasks: [
        { id: 't1', tabs: { left: [tab('t1a', 'terminal')] } },
        { id: 't2', tabs: { left: [tab('t2a', 'claude'), tab('t2b', 'terminal')] } },
        { id: 't3', tabs: { left: [tab('t3a', 'claude-chat')] } },
        { id: 't4', tabs: { left: [tab('t4a', 'claude-chat')] }, workspace: { worktreePath: '/w', branchName: 'b', baseBranch: 'main', relativeProjectPath: '' } },
        { id: 't5', tabs: { left: [tab('t5a', 'note')] } }
      ]
    })
    const summary = projectHomeSummary(project, { t2a: 'attention', t3a: 'working' }, {}, NOW)
    expect(summary.openTasks).toBe(5)
    expect(summary.needsYou).toBe(1)
    expect(summary.working).toBe(1)
    expect(summary.agents).toEqual([
      { label: 'Claude', count: 2 },
      { label: 'Claude Code', count: 1 },
      { label: 'Terminal', count: 1 }
    ])
  })
})

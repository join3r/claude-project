import { describe, expect, it } from 'vitest'
import { taskAgentLabel, taskAgentTab, taskStatusChip } from '../src/renderer/components/taskHeaderState'
import { singlePane } from '../src/shared/streams'
import type { Tab, TabStatusValue, Task, TaskInboxState } from '../src/shared/types'

const NOW = new Date('2026-10-07T12:00:00').getTime()

function makeTask(tabs: Tab[], inbox?: TaskInboxState, extra?: Partial<Task>): Task {
  return { id: 't', name: 'Task', panes: singlePane(tabs), ...(inbox ? { inbox } : {}), ...extra }
}

const chat: Tab = { id: 'chat', type: 'claude-chat', title: 'Claude' }
const code: Tab = { id: 'code', type: 'claude', title: 'Claude Code' }
const shell: Tab = { id: 'sh', type: 'terminal', title: 'Terminal' }

describe('taskAgentLabel', () => {
  it('names the agent, Claude for the chat', () => {
    expect(taskAgentLabel(makeTask([chat, shell]))).toBe('Claude')
    expect(taskAgentLabel(makeTask([code]))).toBe('Claude Code')
    expect(taskAgentLabel(makeTask([{ id: 'c', type: 'codex', title: 'Codex' }]))).toBe('Codex')
    expect(taskAgentLabel(makeTask([{ id: 'p', type: 'pi', title: 'Pi' }]))).toBe('Pi')
  })

  it('says Terminal for a terminal task and nothing for an empty one', () => {
    expect(taskAgentLabel(makeTask([shell]))).toBe('Terminal')
    expect(taskAgentLabel(makeTask([]))).toBeNull()
  })

  it('finds an agent that is not the first tab', () => {
    expect(taskAgentTab(makeTask([shell, code]))?.id).toBe('code')
  })
})

describe('taskStatusChip', () => {
  const statuses = (value: TabStatusValue): Record<string, TabStatusValue> => ({ code: value })

  it('counts how long it has needed you', () => {
    const chip = taskStatusChip(makeTask([code]), statuses('attention'), { code: NOW - 90_000 }, NOW)
    expect(chip).toEqual({ label: 'Needs you · 1m', tone: 'attention' })
  })

  it('shows Working while the agent runs', () => {
    expect(taskStatusChip(makeTask([code]), statuses('working'), {}, NOW)?.label).toBe('Working')
  })

  it("shows Your turn when the agent spoke last", () => {
    const task = makeTask([code], { eventAt: NOW - 1000 }, { lastInteractedAt: NOW - 5000 })
    expect(taskStatusChip(task, statuses('exited'), {}, NOW)).toEqual({ label: 'Your turn', tone: 'turn' })
  })

  it('shows Snoozed and Settled over Your turn', () => {
    const snoozed = makeTask([code], { eventAt: NOW - 1000, snoozedUntil: NOW + 60_000 })
    expect(taskStatusChip(snoozed, {}, {}, NOW)?.label).toBe('Snoozed')
    const settled = makeTask([code], { eventAt: NOW - 5000, settledAt: NOW - 1000 })
    expect(taskStatusChip(settled, {}, {}, NOW)?.label).toBe('Settled')
  })

  it('is empty for a quiet task', () => {
    expect(taskStatusChip(makeTask([code]), {}, {}, NOW)).toBeNull()
  })
})

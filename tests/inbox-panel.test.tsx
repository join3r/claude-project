// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import InboxPanel from '../src/renderer/components/InboxPanel'
import { createMainStream } from '../src/shared/types'
import type { Project, Task } from '../src/shared/types'
import { singlePane } from '../src/shared/streams'

void React

const NOW = new Date('2026-10-07T12:00:00').getTime()

function task(id: string, eventAt: number): Task {
  const tabId = `${id}-tab`
  return {
    id,
    name: `Task ${id}`,
    mainTabId: tabId,
    panes: singlePane([{ id: tabId, type: 'claude', title: 'Claude' }]),
    inbox: { eventAt }
  }
}

const project: Project = {
  id: 'p',
  name: 'DevTool',
  directory: '/tmp/devtool',
  streams: [
    createMainStream('p', [task('a', NOW - 60_000)]),
    { id: 's050', name: '0.5.0', tasks: [task('b', NOW - 1000), task('c', NOW - 120_000)] }
  ]
}

function renderPanel(layout: 'flat' | 'grouped', onClose = vi.fn()) {
  return render(
    <InboxPanel
      projects={[project]}
      selectedTaskId={null}
      onSelectTask={vi.fn()}
      onTaskContextMenu={vi.fn()}
      onSettle={vi.fn()}
      onClose={onClose}
      onNewTask={vi.fn()}
      allStatuses={{}}
      statusSince={{}}
      activities={{}}
      now={NOW}
      layout={layout}
    />
  )
}

afterEach(() => cleanup())

describe('InboxPanel', () => {
  it('flat: one list by recency, each row saying Project · Stream', () => {
    renderPanel('flat')
    const rows = screen.getAllByTestId('inbox-row')
    expect(rows.map(row => row.dataset.taskId)).toEqual(['b', 'a', 'c'])
    expect(screen.getAllByTestId('inbox-row-location').map(el => el.textContent))
      .toEqual(['DevTool·0.5.0', 'DevTool·main', 'DevTool·0.5.0'])
    expect(screen.queryByTestId('inbox-stream-header')).toBeNull()
    expect(screen.queryByText('ws')).toBeNull()
  })

  it('grouped: rows gathered under a header per stream, without the location line', () => {
    renderPanel('grouped')
    const groups = screen.getAllByTestId('inbox-stream-group')
    expect(groups.map(group => group.querySelector('[data-testid="inbox-stream-header"]')?.textContent))
      .toEqual(['DevTool0.5.0', 'DevToolmain'])
    expect(screen.getAllByTestId('inbox-row').map(row => row.dataset.taskId)).toEqual(['b', 'c', 'a'])
    expect(screen.queryByTestId('inbox-row-location')).toBeNull()
  })

  it('closes a task from its row', () => {
    const onClose = vi.fn()
    renderPanel('flat', onClose)
    const row = screen.getAllByTestId('inbox-row').find(el => el.dataset.taskId === 'a')!
    fireEvent.click(row.querySelector('button[title="Close task"]')!)
    expect(onClose).toHaveBeenCalledWith('p', 'a')
  })
})

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

function task(id: string, inbox: Task['inbox'], lastInteractedAt?: number): Task {
  const tabId = `${id}-tab`
  return {
    id,
    name: `Task ${id}`,
    mainTabId: tabId,
    panes: singlePane([{ id: tabId, type: 'claude', title: 'Claude' }]),
    inbox,
    ...(lastInteractedAt !== undefined ? { lastInteractedAt } : {})
  }
}

// a: your turn (main) · b: your turn (0.5.0) · c: needs you (0.5.0) · d: working (main) · e: quiet (0.5.0)
const devtool: Project = {
  id: 'p',
  name: 'DevTool',
  directory: '/tmp/devtool',
  streams: [
    createMainStream('p', [task('a', { eventAt: NOW - 60_000 }), task('d', { eventAt: NOW - 30_000 })]),
    {
      id: 's050',
      name: '0.5.0',
      tasks: [
        task('b', { eventAt: NOW - 1000 }),
        task('c', { eventAt: NOW - 120_000 }),
        task('e', { eventAt: NOW - 300_000 }, NOW - 200_000)
      ]
    }
  ]
}
// Stem's only task is your turn, on its main stream.
const stem: Project = {
  id: 'q',
  name: 'Stem',
  directory: '/tmp/stem',
  streams: [createMainStream('q', [task('f', { eventAt: NOW - 90_000 })])]
}

const statuses = { 'c-tab': 'attention' as const, 'd-tab': 'working' as const }
const since = { 'c-tab': NOW - 120_000, 'd-tab': NOW - 30_000 }

function renderPanel(layout: 'flat' | 'grouped', handlers: { onClose?: () => void; onSettle?: () => void; onSnooze?: () => void } = {}) {
  return render(
    <InboxPanel
      projects={[devtool, stem]}
      selectedTaskId={null}
      onSelectTask={vi.fn()}
      onTaskContextMenu={vi.fn()}
      onSettle={handlers.onSettle ?? vi.fn()}
      onSnooze={handlers.onSnooze ?? vi.fn()}
      onClose={handlers.onClose ?? vi.fn()}
      onNewTask={vi.fn()}
      allStatuses={statuses}
      statusSince={since}
      activities={{}}
      now={NOW}
      theme="dark"
      layout={layout}
    />
  )
}

const rowIds = () => screen.getAllByTestId('inbox-row').map(row => row.dataset.taskId)
const headers = () => screen.getAllByTestId('inbox-group-header').map(el => el.textContent)
const row = (id: string) => screen.getAllByTestId('inbox-row').find(el => el.dataset.taskId === id)!

afterEach(() => cleanup())

describe('InboxPanel', () => {
  it('flat: Needs you, Your turn, then Working folded, Quiet', () => {
    renderPanel('flat')
    expect(headers()).toEqual(['Needs you1', 'Your turn3', 'Working1', 'Quiet1'])
    // Working is folded by default: its row only shows once opened.
    expect(rowIds()).toEqual(['c', 'b', 'a', 'f', 'e'])
    fireEvent.click(screen.getByText('Working'))
    expect(rowIds()).toEqual(['c', 'b', 'a', 'f', 'd', 'e'])
    expect(row('d').className).toContain('opacity-50')
  })

  it('flat rows lead with the project, then the stream unless it is main', () => {
    renderPanel('flat')
    const place = (id: string) => row(id).querySelector('[data-testid="inbox-row-place"]')?.textContent
    expect(place('b')).toBe('DevTool›0.5.0')
    expect(place('a')).toBe('DevTool')
    expect(place('f')).toBe('Stem')
    expect(row('b').querySelector('[data-testid="inbox-row-name"]')?.textContent).toBe('Task b')
  })

  it('says what a blocked task needs, in the attention colour', () => {
    renderPanel('flat')
    const need = row('c').querySelector('[data-testid="inbox-row-need"]')!
    expect(need.textContent).toBe('needs you · waiting 2m')
    expect(need.className).toContain('text-status-attention')
    // A your-turn row with nothing to report adds no line: its group header says it.
    expect(row('b').querySelector('[data-testid="inbox-row-need"]')).toBeNull()
  })

  it('grouped: open rows under a header per project, stream as a label on the row', () => {
    renderPanel('grouped')
    const groups = screen.getAllByTestId('inbox-project-group')
    expect(groups.map(group => group.querySelector('[data-testid="inbox-project-header"]')?.textContent))
      .toEqual(['DTDevTool4', 'STStem1'])
    // Tile initials, name, count. DevTool holds the task that needs you, so it comes first; Working stays folded below.
    expect(rowIds()).toEqual(['c', 'b', 'a', 'e', 'f'])
    expect(headers()).toEqual(['Working1'])
    const place = (id: string) => row(id).querySelector('[data-testid="inbox-row-place"]')?.textContent
    expect(place('c')).toBe('0.5.0')
    // On main there is nothing to say under the project header: the task name leads.
    expect(row('a').querySelector('[data-testid="inbox-row-place"]')).toBeNull()
  })

  it('settles, snoozes and closes a task from its row', () => {
    const onClose = vi.fn()
    const onSettle = vi.fn()
    const onSnooze = vi.fn()
    renderPanel('flat', { onClose, onSettle, onSnooze })
    fireEvent.click(row('a').querySelector('button[title="Settle"]')!)
    expect(onSettle).toHaveBeenCalledWith('p', 'a')
    fireEvent.click(row('a').querySelector('button[title="Snooze…"]')!)
    expect(onSnooze).toHaveBeenCalledWith(expect.anything(), 'p', 'a')
    fireEvent.click(row('a').querySelector('button[title="Close task"]')!)
    expect(onClose).toHaveBeenCalledWith('p', 'a')
  })

  it('has no inline approvals or filter chips', () => {
    renderPanel('flat')
    expect(screen.queryByRole('button', { name: /allow|deny/i })).toBeNull()
    expect(screen.queryByText(/filter/i)).toBeNull()
  })
})

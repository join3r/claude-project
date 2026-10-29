// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import InboxApps from '../src/renderer/components/InboxApps'
import { inboxApps } from '../src/renderer/components/inbox'
import { createMainStream } from '../src/shared/types'
import type { Project } from '../src/shared/types'
import type { StreamRunState } from '../src/shared/stream-run'

void React

const NOW = 1_000_000_000

const api: Project = {
  id: 'p',
  name: 'api-server',
  directory: '/tmp/api',
  runCommand: './server.sh',
  streams: [
    { ...createMainStream('p'), id: 'p-main' },
    { id: 'p-050', name: '0.5.0', tasks: [] },
    { id: 'p-old', name: 'old', tasks: [] }
  ]
}
const site: Project = {
  id: 'q',
  name: 'site',
  directory: '/tmp/site',
  streams: [{ ...createMainStream('q'), id: 'q-main', runCommand: 'sh boom.sh' }, { id: 'q-x', name: 'x', tasks: [] }]
}

const r = { commandId: 'run', name: 'run' }
const runs: Record<string, StreamRunState> = {
  'p-main~run': { ...r, status: 'running', command: './server.sh', startedAt: NOW - 25 * 60_000 },
  'p-050~run': { ...r, status: 'running', command: './server.sh', startedAt: NOW - 60_000 },
  'p-old~run': { ...r, status: 'exited', command: './server.sh', startedAt: NOW - 600_000, endedAt: NOW - 500_000, exitCode: 0 },
  'q-main~run': { ...r, status: 'exited', command: 'sh boom.sh', startedAt: NOW - 300_000, endedAt: NOW - 200_000, exitCode: 3 },
  'q-x~run': { ...r, status: 'stopped', command: 'x', startedAt: NOW - 300_000, endedAt: NOW - 100_000 }
}

describe('inboxApps', () => {
  it('lists crashes first (latest ended on top), then running apps (latest started on top)', () => {
    const apps = inboxApps([api, site], runs)
    expect(apps.map(app => [app.stream.id, app.crashed])).toEqual([['q-main', true], ['p-050', false], ['p-main', false]])
  })

  it('leaves out a dismissed crash until its stream runs again', () => {
    expect(inboxApps([api, site], runs, new Set([`q-main~run:${NOW - 300_000}`])).map(app => app.stream.id)).toEqual(['p-050', 'p-main'])
    const again = { ...runs, 'q-main~run': { ...runs['q-main~run'], startedAt: NOW - 10_000, endedAt: NOW } }
    expect(inboxApps([api, site], again, new Set([`q-main~run:${NOW - 300_000}`]))[0].stream.id).toBe('q-main')
  })

  it('lists each command of a stream on its own row', () => {
    const both = { ...runs, 'p-main~c-staging': { commandId: 'c-staging', name: 'run (staging)', status: 'running' as const, command: 'x', startedAt: NOW - 1000 } }
    expect(inboxApps([api], both).map(app => [app.stream.id, app.run.commandId])).toEqual([['p-main', 'c-staging'], ['p-050', 'run'], ['p-main', 'run']])
  })

  it('counts a missing exit code as a crash', () => {
    const lost = { 'q-main~run': { ...r, status: 'exited' as const, command: 'x', startedAt: 1 } }
    expect(inboxApps([site], lost)[0]?.crashed).toBe(true)
  })
})

describe('InboxApps', () => {
  const control = vi.fn(async () => ({ ok: true as const }))
  beforeAll(() => {
    ;(window as any).api = {
      streamRunStates: vi.fn(async (projectId: string) =>
        Object.fromEntries(Object.entries(runs).filter(([key]) => key.startsWith(`${projectId}-`)))),
      onStreamRunState: vi.fn(() => () => {}),
      streamRunControl: control
    }
  })
  afterEach(() => cleanup())

  it('fetches every project’s runs and lists the apps, hover actions per state', async () => {
    const onStreamMenu = vi.fn()
    render(<InboxApps projects={[api, site]} now={NOW} theme="dark" showIcons={false} onStreamMenu={onStreamMenu} />)
    await waitFor(() => expect(screen.getAllByTestId('inbox-app-row')).toHaveLength(3))
    const rows = screen.getAllByTestId('inbox-app-row')
    expect(rows.map(row => row.dataset.streamId)).toEqual(['q-main', 'p-050', 'p-main'])
    expect(within(rows[0]).getByTestId('inbox-app-status').textContent).toBe('exited 3')
    expect(within(rows[2]).getByTestId('inbox-app-status').textContent).toBe('25m')
    // Main is not named; another stream is.
    expect(rows[2].textContent).not.toContain('main')
    expect(rows[1].textContent).toContain('0.5.0')

    expect(within(rows[2]).getByTestId('inbox-app-command').textContent).toBe('· run')

    fireEvent.click(within(rows[2]).getByTitle('Stop run'))
    expect(control).toHaveBeenCalledWith('p', 'p-main', 'run', 'stop')
    fireEvent.click(within(rows[2]).getByTitle('Restart run'))
    expect(control).toHaveBeenCalledWith('p', 'p-main', 'run', 'restart')
    fireEvent.click(within(rows[0]).getByTitle('Run run again: sh boom.sh'))
    expect(control).toHaveBeenCalledWith('q', 'q-main', 'run', 'start')

    fireEvent.contextMenu(rows[1], { clientX: 5, clientY: 6 })
    expect(onStreamMenu).toHaveBeenCalledWith({ x: 5, y: 6 }, 'p', 'p-050')

    act(() => { fireEvent.click(within(rows[0]).getByTitle('Dismiss until it runs again')) })
    expect(screen.getAllByTestId('inbox-app-row').map(row => row.dataset.streamId)).toEqual(['p-050', 'p-main'])
  })

  it('renders nothing without apps', () => {
    const { container } = render(<InboxApps projects={[]} now={NOW} theme="dark" showIcons={false} onStreamMenu={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })
})

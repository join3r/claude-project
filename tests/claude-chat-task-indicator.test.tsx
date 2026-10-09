// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskIndicator from '../src/renderer/components/claude-chat/TaskIndicator'
import ArtifactIndicator from '../src/renderer/components/claude-chat/ArtifactIndicator'
import { TASK_LINGER_MS, type ChatTask } from '../src/shared/claude-chat'

void React

const NOW = 1_000_000

function task(partial: Partial<ChatTask> & { id: string }): ChatTask {
  return { kind: 'subagent', description: partial.id, background: false, status: 'running', startedAt: NOW - 5000, ...partial }
}

function renderIndicator(tasks: ChatTask[], overrides: Partial<React.ComponentProps<typeof TaskIndicator>> = {}) {
  const props: React.ComponentProps<typeof TaskIndicator> = {
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    onStop: vi.fn(),
    onBackground: vi.fn(),
    onJump: vi.fn(),
    canJump: () => true,
    ...overrides
  }
  const view = render(<TaskIndicator {...props} />)
  return { props, view }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TaskIndicator', () => {
  it('is hidden with no tasks', () => {
    const { view } = renderIndicator([])
    expect(view.container.innerHTML).toBe('')
  })

  it('counts running tasks by kind', () => {
    renderIndicator([
      task({ id: 'a1' }),
      task({ id: 'a2', background: true }),
      task({ id: 's1', kind: 'shell', command: 'sleep 120', background: true }),
      task({ id: 'done', kind: 'shell', status: 'completed', endedAt: NOW - 1000 })
    ])
    expect(screen.getByRole('button', { name: 'Running: 2 agents · 1 shell' })).toBeTruthy()
  })

  it('shows finished tasks for the linger, then disappears', () => {
    const { view } = renderIndicator([task({ id: 'b1', kind: 'shell', status: 'failed', endedAt: NOW - (TASK_LINGER_MS - 3000) })])
    expect(screen.getByRole('button', { name: 'Finished: 1 shell done' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(4000) })
    expect(view.container.innerHTML).toBe('')
  })

  it('disarms the stop button if the second click does not come within 3s', () => {
    const { props } = renderIndicator([task({ id: 'sh', kind: 'shell', description: 'Tail logs' })])
    fireEvent.click(screen.getByRole('button', { name: /Running:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop task' }))
    expect(screen.getByRole('button', { name: 'Confirm stop Tail logs' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(3000) })
    fireEvent.click(screen.getByRole('button', { name: 'Stop task' }))
    expect(props.onStop).not.toHaveBeenCalled()
  })

  it('lists rows with actions that call back, and closes on Escape', () => {
    const { props } = renderIndicator([
      task({ id: 'fg', toolUseId: 'tu-fg', description: 'Explore the router', agentType: 'Explore', toolUses: 4, tokens: 12_000 }),
      task({ id: 'bg', toolUseId: 'tu-bg', kind: 'shell', description: 'Dev server', command: 'npm run dev', background: true })
    ])
    fireEvent.click(screen.getByRole('button', { name: /Running:/ }))
    expect(screen.getByText('bg')).toBeTruthy()
    expect(screen.getByText(/Explore · 5s · 4 tools · 12k tokens/)).toBeTruthy()
    expect(screen.getByText('$ npm run dev')).toBeTruthy()

    // Only the foreground task can be sent to the background.
    const background = screen.getAllByRole('button', { name: 'Send to background' })
    expect(background).toHaveLength(1)
    fireEvent.click(background[0])
    expect(props.onBackground).toHaveBeenCalledWith('tu-fg')

    // Stopping takes a second click; the first only arms the button.
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop task' })[1])
    expect(props.onStop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop Dev server' }))
    expect(props.onStop).toHaveBeenCalledWith('bg')

    fireEvent.click(screen.getByRole('button', { name: 'Show Dev server in the conversation' }))
    expect(props.onJump).toHaveBeenCalledWith('tu-bg')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Running:/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not offer a jump for a task whose tool call is not in the timeline', () => {
    renderIndicator([task({ id: 'n1', toolUseId: 'sub-tu', description: 'Nested' })], { canJump: () => false })
    fireEvent.click(screen.getByRole('button', { name: /Running:/ }))
    expect(screen.queryByRole('button', { name: 'Show Nested in the conversation' })).toBeNull()
    expect(screen.getByText('Nested')).toBeTruthy()
  })

  it('ticks elapsed time', () => {
    renderIndicator([task({ id: 'a1', agentType: 'Plan' })])
    fireEvent.click(screen.getByRole('button', { name: /Running:/ }))
    expect(screen.getByText('Plan · 5s')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByText('Plan · 7s')).toBeTruthy()
  })
})

describe('ArtifactIndicator', () => {
  const artifacts = [
    { url: 'https://claude.ai/artifact/b', title: 'Inbox Grouping', description: 'Four alternatives', toolUseId: 'b1', publishes: 1 },
    { url: 'https://claude.ai/artifact/a', title: 'Limit Bars', toolUseId: 'a2', publishes: 2 }
  ]

  it('is hidden with no artifacts', () => {
    const { container } = render(<ArtifactIndicator artifacts={[]} onOpen={vi.fn()} onOpenExternal={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('lists artifacts and opens them in the app or the browser', () => {
    const onOpen = vi.fn()
    const onOpenExternal = vi.fn()
    render(<ArtifactIndicator artifacts={artifacts} onOpen={onOpen} onOpenExternal={onOpenExternal} />)
    fireEvent.click(screen.getByRole('button', { name: 'Artifacts: 2 artifacts' }))
    expect(screen.getByText('Published 2 times')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Inbox Grouping' }))
    expect(onOpen).toHaveBeenCalledWith('https://claude.ai/artifact/b')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Artifacts: 2 artifacts' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Open in browser' })[1])
    expect(onOpenExternal).toHaveBeenCalledWith('https://claude.ai/artifact/a')
  })
})

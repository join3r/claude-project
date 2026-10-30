// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React, { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import RunCommandsEditor, { type RunCommandDraft, type RunCommandSuggestion } from '../src/renderer/components/RunCommandsEditor'

void React

afterEach(cleanup)

function Harness({ suggest, initial }: { suggest: (current: Array<{ name: string; command: string }>) => Promise<RunCommandSuggestion>; initial: RunCommandDraft[] }) {
  const [value, setValue] = useState(initial)
  return <RunCommandsEditor value={value} onChange={setValue} suggest={suggest} />
}

describe('RunCommandsEditor Suggest', () => {
  it('fills in and marks the suggested rows, under StrictMode too', async () => {
    let answer: (r: RunCommandSuggestion) => void = () => {}
    const suggest = vi.fn(() => new Promise<RunCommandSuggestion>((resolve) => { answer = resolve }))
    render(<StrictMode><Harness suggest={suggest} initial={[{ id: 'a', name: 'run', command: 'npm start' }]} /></StrictMode>)
    fireEvent.click(screen.getByTestId('run-command-suggest'))
    expect(suggest).toHaveBeenCalledWith([{ name: 'run', command: 'npm start' }])
    expect(screen.getByTestId('run-command-suggest').textContent).toContain('reading')
    await act(async () => { answer({ ok: true, commands: [{ name: 'install', command: 'pnpm i' }, { name: 'run', command: 'pnpm dev' }] }) })
    const rows = screen.getAllByTestId('run-command-row')
    expect(rows.map(r => [...r.querySelectorAll('input')].map(i => i.value))).toEqual([['run', 'pnpm dev'], ['install', 'pnpm i']])
    expect(rows.every(r => r.dataset.suggested === 'true')).toBe(true)
    expect(screen.getByTestId('run-command-suggest-status').textContent).toContain('2 commands')
  })

  it('shows the error', async () => {
    render(<Harness suggest={() => Promise.resolve({ ok: false, error: 'Claude is turned off in Settings' })} initial={[]} />)
    await act(async () => { fireEvent.click(screen.getByTestId('run-command-suggest')) })
    expect(screen.getByTestId('run-command-suggest-status').textContent).toBe('Claude is turned off in Settings')
  })
})

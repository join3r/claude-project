// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PromptCard from '../src/renderer/components/claude-chat/PromptCards'
import type { ChatPrompt } from '../src/shared/claude-chat'

void React

afterEach(cleanup)

const question: ChatPrompt = {
  id: 'p1',
  kind: 'question',
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      { question: 'Which ORM?', header: 'ORM', options: [{ label: 'Drizzle' }, { label: 'None' }] }
    ]
  }
}

describe('PromptCard collapse', () => {
  it('folds a question down to its header and a one-line summary', () => {
    render(<PromptCard prompt={question} onRespond={vi.fn()} />)
    const header = screen.getByRole('button', { name: /Claude has a question/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Postgres')).toBeTruthy()

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Postgres')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
    expect(screen.getByText('Which database? (+1 more)')).toBeTruthy()
  })

  it('keeps picked answers across a collapse', () => {
    const onRespond = vi.fn()
    render(<PromptCard prompt={question} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Postgres'))
    fireEvent.click(screen.getByText('Drizzle'))

    const header = screen.getByRole('button', { name: /Claude has a question/ })
    fireEvent.click(header)
    fireEvent.click(header)

    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(onRespond.mock.calls[0][0])).toContain('Postgres')
    expect(JSON.stringify(onRespond.mock.calls[0][0])).toContain('Drizzle')
  })

  it('summarizes a collapsed plan by its first line', () => {
    const plan: ChatPrompt = { id: 'p2', kind: 'plan', toolName: 'ExitPlanMode', input: { plan: '# Add caching\n\nSteps…' } }
    render(<PromptCard prompt={plan} onRespond={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Plan ready for review/ }))
    expect(screen.getByText('Add caching')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })
})

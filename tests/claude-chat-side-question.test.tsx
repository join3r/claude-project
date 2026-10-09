// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Composer from '../src/renderer/components/claude-chat/Composer'
import SideQuestion from '../src/renderer/components/claude-chat/SideQuestion'
import { chatEnv } from '../src/main/claude-chat/chat-session'
import { parseSideQuestion } from '../src/shared/claude-chat'

void React

afterEach(cleanup)

describe('parseSideQuestion', () => {
  it('takes the question after /btw', () => {
    expect(parseSideQuestion('/btw what does foo do?')).toBe('what does foo do?')
    expect(parseSideQuestion('  /btw  multi\nline  ')).toBe('multi\nline')
  })

  it("is '' for a bare /btw and null for anything else", () => {
    expect(parseSideQuestion('/btw')).toBe('')
    expect(parseSideQuestion('/btwx hi')).toBeNull()
    expect(parseSideQuestion('hi /btw there')).toBeNull()
    expect(parseSideQuestion('/review')).toBeNull()
  })
})

describe('chatEnv', () => {
  it('turns the Artifact tool on unless the env says otherwise', () => {
    expect(chatEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', CLAUDE_CODE_ARTIFACT: '1' })
    expect(chatEnv({ CLAUDE_CODE_ARTIFACT: '0' })).toEqual({ CLAUDE_CODE_ARTIFACT: '0' })
  })
})

function renderComposer() {
  const props: React.ComponentProps<typeof Composer> = {
    busy: false,
    info: {},
    models: [],
    commands: [],
    loadFiles: () => Promise.resolve([]),
    onSend: vi.fn(),
    onSideQuestion: vi.fn(),
    onBash: vi.fn(),
    onPermissions: vi.fn(),
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    onStop: vi.fn(),
    onSetModel: vi.fn(),
    onSetMode: vi.fn(),
    onSetEffort: vi.fn(),
    onOpenInTerminal: vi.fn(),
    focusSignal: false
  }
  render(<Composer {...props} />)
  const textarea = screen.getByRole('textbox')
  const submit = (text: string): void => {
    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
  }
  return { props, textarea, submit }
}

describe('Composer /btw', () => {
  it('asks a side question instead of sending', () => {
    const { props, textarea, submit } = renderComposer()
    submit('/btw why is the sky blue?')
    expect(props.onSideQuestion).toHaveBeenCalledWith('why is the sky blue?')
    expect(props.onSend).not.toHaveBeenCalled()
    expect((textarea as HTMLTextAreaElement).value).toBe('')
  })

  it('ignores a bare /btw', () => {
    const { props, submit } = renderComposer()
    submit('/btw')
    expect(props.onSideQuestion).not.toHaveBeenCalled()
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('still sends other messages', () => {
    const { props, submit } = renderComposer()
    submit('hello')
    expect(props.onSend).toHaveBeenCalledWith('hello', [])
    expect(props.onSideQuestion).not.toHaveBeenCalled()
  })
})

describe('Composer ! and /permissions', () => {
  it('runs a !command instead of sending it', () => {
    const { props, textarea, submit } = renderComposer()
    submit('!  git status ')
    expect(props.onBash).toHaveBeenCalledWith('git status')
    expect(props.onSend).not.toHaveBeenCalled()
    expect((textarea as HTMLTextAreaElement).value).toBe('')
  })

  it('ignores a bare !', () => {
    const { props, submit } = renderComposer()
    submit('!')
    expect(props.onBash).not.toHaveBeenCalled()
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it('opens the rules editor for /permissions rather than a terminal', () => {
    const { props, submit } = renderComposer()
    submit('/permissions')
    expect(props.onPermissions).toHaveBeenCalled()
    expect(props.onOpenInTerminal).not.toHaveBeenCalled()
    expect(props.onSend).not.toHaveBeenCalled()
  })
})

describe('SideQuestion', () => {
  it('shows the question, then the answer, and dismisses', () => {
    const onDismiss = vi.fn()
    const onOpenLink = vi.fn()
    const { rerender } = render(
      <SideQuestion side={{ id: 1, question: 'what is x?', status: 'asking' }} onDismiss={onDismiss} onOpenLink={onOpenLink} />
    )
    expect(screen.getByText('what is x?')).toBeTruthy()
    expect(screen.getByText('Thinking…')).toBeTruthy()

    rerender(
      <SideQuestion side={{ id: 1, question: 'what is x?', status: 'done', answer: 'See [docs](https://example.com)' }} onDismiss={onDismiss} onOpenLink={onOpenLink} />
    )
    fireEvent.click(screen.getByText('docs'))
    expect(onOpenLink).toHaveBeenCalledWith('https://example.com')

    fireEvent.click(screen.getByTitle('Dismiss'))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('shows an error', () => {
    render(<SideQuestion side={{ id: 1, question: 'q', status: 'error', error: 'Claude is not running.' }} onDismiss={vi.fn()} onOpenLink={vi.fn()} />)
    expect(screen.getByText('Claude is not running.')).toBeTruthy()
  })
})

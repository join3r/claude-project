// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import Composer from '../src/renderer/components/claude-chat/Composer'
import { queueAgentInsert } from '../src/renderer/agentLink/linkToAgent'

void React

const noop = (): void => {}

function renderComposer(tabId = 'chat-1') {
  return render(
    <Composer
      busy={false}
      info={{} as any}
      models={[]}
      commands={[]}
      loadFiles={async () => []}
      onSend={noop}
      onSideQuestion={noop}
      onBash={noop}
      onPermissions={noop}
      onLogin={noop}
      onLogout={noop}
      onStop={noop}
      onSetModel={noop}
      onSetMode={noop}
      onSetEffort={noop}
      onOpenInTerminal={noop}
      focusSignal={false}
      tabId={tabId}
    />
  )
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

async function insert(tabId: string, text: string): Promise<void> {
  await act(async () => {
    queueAgentInsert(tabId, text)
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
  })
}

afterEach(() => cleanup())

describe('Composer agent links', () => {
  it('inserts a link into an empty draft and focuses it', async () => {
    renderComposer()
    await insert('chat-1', '@src/foo.ts (lines 1-2) ')
    expect(textarea().value).toBe('@src/foo.ts (lines 1-2) ')
    expect(document.activeElement).toBe(textarea())
    expect(textarea().selectionStart).toBe('@src/foo.ts (lines 1-2) '.length)
  })

  it('inserts at the caret, with a space so it does not touch a word', async () => {
    renderComposer()
    fireEvent.change(textarea(), { target: { value: 'look at' } })
    textarea().setSelectionRange(7, 7)
    await insert('chat-1', '@a.ts ')
    expect(textarea().value).toBe('look at @a.ts ')
  })

  it('ignores links addressed to another tab', async () => {
    renderComposer()
    await insert('chat-2', '@a.ts ')
    expect(textarea().value).toBe('')
  })
})

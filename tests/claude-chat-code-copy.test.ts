// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { handleCodeCopyClick, handleCodeRunClick, renderChatMarkdown, runnableCommand } from '../src/renderer/components/claude-chat/markdown'

describe('chat code block Copy', () => {
  it('survives sanitizing and copies the code, not the button', async () => {
    const clipboardWriteText = vi.fn(() => Promise.resolve())
    ;(window as unknown as { api: unknown }).api = { clipboardWriteText }
    const host = document.createElement('div')
    host.innerHTML = renderChatMarkdown('Run:\n\n```sh\nnpm test <x>\n```')
    const button = host.querySelector('button[data-chat-copy]')
    expect(button?.textContent).toBe('Copy')
    expect(handleCodeCopyClick(button)).toBe(true)
    expect(clipboardWriteText).toHaveBeenCalledWith('npm test <x>')
    await Promise.resolve()
    expect(button?.textContent).toBe('Copied')
    expect(handleCodeCopyClick(host.querySelector('p'))).toBe(false)
  })
})

describe('chat code block Run', () => {
  const render = (markdown: string): HTMLDivElement => {
    const host = document.createElement('div')
    host.innerHTML = renderChatMarkdown(markdown)
    return host
  }

  it('shows on shell blocks and !command blocks only', () => {
    expect(render('```bash\nls\n```').querySelector('[data-chat-run]')).not.toBeNull()
    expect(render('```\n! gh auth login\n```').querySelector('[data-chat-run]')).not.toBeNull()
    expect(render('```\nplain output\n```').querySelector('[data-chat-run]')).toBeNull()
    expect(render('```ts\nconst a = 1\n```').querySelector('[data-chat-run]')).toBeNull()
  })

  it('runs the command without its ! and ignores clicks elsewhere', () => {
    const host = render('```\n! npm test <x>\n```')
    const run = vi.fn()
    expect(handleCodeRunClick(host.querySelector('[data-chat-run]'), run)).toBe(true)
    expect(run).toHaveBeenCalledWith('npm test <x>')
    expect(host.querySelector('[data-chat-run]')?.textContent).toBe('Sent')
    // A second click while it says Sent doesn't run it twice.
    handleCodeRunClick(host.querySelector('[data-chat-run]'), run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(handleCodeRunClick(host.querySelector('[data-chat-copy]'), run)).toBe(false)
  })

  it('strips $ prompts only when every line has one', () => {
    expect(runnableCommand('$ cd x\n$ ls')).toBe('cd x\nls')
    expect(runnableCommand('$ echo hi\nhi')).toBe('$ echo hi\nhi')
    expect(runnableCommand('!ls -la')).toBe('ls -la')
  })
})

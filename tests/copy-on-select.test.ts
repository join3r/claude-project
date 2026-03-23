import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindCopyOnSelect, writeClipboardText } from '../src/renderer/components/copyOnSelect'

describe('copyOnSelect', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copies non-empty selections when the terminal selection changes', async () => {
    let listener: (() => void) | null = null
    const writeText = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined)
    const term = {
      onSelectionChange: (nextListener: () => void) => {
        listener = nextListener
        return { dispose: () => { listener = null } }
      },
      getSelection: () => 'selected text'
    }

    const disposable = bindCopyOnSelect(term, writeText)
    listener?.()
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith('selected text')

    disposable.dispose()
    expect(listener).toBeNull()
  })

  it('ignores empty selections', async () => {
    let listener: (() => void) | null = null
    const writeText = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined)
    const term = {
      onSelectionChange: (nextListener: () => void) => {
        listener = nextListener
        return { dispose: () => { listener = null } }
      },
      getSelection: () => ''
    }

    bindCopyOnSelect(term, writeText)
    listener?.()
    await Promise.resolve()

    expect(writeText).not.toHaveBeenCalled()
  })

  it('prefers the Electron clipboard bridge', async () => {
    const clipboardWriteText = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { clipboardWriteText } })
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined) }
    })

    await writeClipboardText('hello')

    expect(clipboardWriteText).toHaveBeenCalledWith('hello')
  })

  it('falls back to navigator clipboard when the bridge fails', async () => {
    const clipboardWriteText = vi.fn<(_: string) => Promise<void>>().mockRejectedValue(new Error('bridge down'))
    const navigatorWriteText = vi.fn<(_: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { clipboardWriteText } })
    vi.stubGlobal('navigator', { clipboard: { writeText: navigatorWriteText } })

    await writeClipboardText('hello')

    expect(clipboardWriteText).toHaveBeenCalledWith('hello')
    expect(navigatorWriteText).toHaveBeenCalledWith('hello')
  })
})

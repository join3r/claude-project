// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// React import is required by the JSX runtime under vitest's default transform.
void React

const SAVE_KEYBINDING = 2048 | 49 // CtrlCmd + S

const mocks = vi.hoisted(() => ({
  /** Monaco commands registered through `editor.addCommand`, by keybinding. */
  commands: new Map<number, () => void>(),
  layoutCalls: { count: 0 }
}))

/**
 * Stand-in for the real Monaco wrapper. It matches the two behaviours that
 * matter here: the buffer lives inside the editor instance (so unmounting the
 * component throws it away, exactly like the real wrapper disposing its model),
 * and it is seeded from `defaultValue` only at creation time.
 */
vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')

  function MockEditor({ defaultValue, onMount, onChange }: {
    defaultValue?: string
    onMount?: (ed: unknown) => void
    onChange?: (value: string | undefined) => void
  }) {
    const valueRef = React.useRef(defaultValue ?? '')
    const [, forceRender] = React.useState(0)
    const edRef = React.useRef<Record<string, unknown> | null>(null)

    if (edRef.current === null) {
      edRef.current = {
        getValue: () => valueRef.current,
        setValue: (next: string) => {
          valueRef.current = next
          forceRender(n => n + 1)
        },
        addCommand: (keybinding: number, handler: () => void) => {
          mocks.commands.set(keybinding, handler)
        },
        updateOptions: () => {},
        layout: () => {
          mocks.layoutCalls.count += 1
        }
      }
    }

    React.useEffect(() => {
      onMount?.(edRef.current)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return React.createElement('textarea', {
      'data-testid': 'monaco',
      value: valueRef.current,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        valueRef.current = event.target.value
        forceRender(n => n + 1)
        onChange?.(event.target.value)
      }
    })
  }

  return { default: MockEditor }
})

// EditorTab only reads `config` off the app context.
vi.mock('../src/renderer/context/AppContext', () => ({
  useApp: () => ({ config: null })
}))

import EditorTab from '../src/renderer/components/EditorTab'

const DISK_CONTENT = 'line one\nline two\n'

let unhandledRejections: unknown[] = []
const recordRejection = (reason: unknown) => {
  unhandledRejections.push(reason)
}

function renderTab(visible = true) {
  return render(
    <EditorTab
      tabId="tab-1"
      visible={visible}
      filePath="src/notes.txt"
      projectDir="/project"
      projectId="p1"
      taskId="t1"
      pane="left"
      effectiveTheme="dark"
    />
  )
}

function editor(): HTMLTextAreaElement {
  return screen.getByTestId('monaco') as HTMLTextAreaElement
}

/** Let pending promise callbacks and any unhandled-rejection reports settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function triggerSave(): Promise<void> {
  const save = mocks.commands.get(SAVE_KEYBINDING)
  expect(save).toBeTypeOf('function')
  await act(async () => {
    save!()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  mocks.commands.clear()
  mocks.layoutCalls.count = 0
  unhandledRejections = []
  process.on('unhandledRejection', recordRejection)
  ;(window as any).api = {
    fbReadFile: vi.fn().mockResolvedValue(DISK_CONTENT),
    fbWriteFile: vi.fn().mockResolvedValue(undefined)
  }
})

afterEach(() => {
  process.off('unhandledRejection', recordRejection)
  cleanup()
  vi.restoreAllMocks()
})

describe('EditorTab', () => {
  it('keeps an unsaved buffer and its dirty state across hide/show', async () => {
    const view = renderTab(true)

    await waitFor(() => expect(editor().value).toBe(DISK_CONTENT))

    await act(async () => {
      fireEvent.change(editor(), { target: { value: 'unsaved edit' } })
    })
    expect(editor().value).toBe('unsaved edit')
    expect(screen.getByTitle('Unsaved changes')).toBeTruthy()

    // Hide the tab (another tab became active), then bring it back.
    await act(async () => {
      view.rerender(
        <EditorTab
          tabId="tab-1"
          visible={false}
          filePath="src/notes.txt"
          projectDir="/project"
          projectId="p1"
          taskId="t1"
          pane="left"
          effectiveTheme="dark"
        />
      )
    })
    await act(async () => {
      view.rerender(
        <EditorTab
          tabId="tab-1"
          visible={true}
          filePath="src/notes.txt"
          projectDir="/project"
          projectId="p1"
          taskId="t1"
          pane="left"
          effectiveTheme="dark"
        />
      )
    })
    await flush()

    // The buffer survived, the on-becoming-visible refresh did not clobber it
    // with disk content, and the dirty marker still reflects reality.
    expect(editor().value).toBe('unsaved edit')
    expect(screen.getByTitle('Unsaved changes')).toBeTruthy()
    // The hidden editor measured against a zero-sized box; it must re-layout.
    expect(mocks.layoutCalls.count).toBeGreaterThan(0)
  })

  it('reports a failed save in the tab instead of rejecting globally', async () => {
    ;(window as any).api.fbWriteFile = vi.fn().mockRejectedValue(
      new Error("EACCES: permission denied, open '/project/src/notes.txt'")
    )

    renderTab(true)
    await waitFor(() => expect(editor().value).toBe(DISK_CONTENT))

    await act(async () => {
      fireEvent.change(editor(), { target: { value: 'unsaved edit' } })
    })

    await triggerSave()
    await flush()

    // Nothing escaped to main.tsx's unhandled-rejection crash screen.
    expect(unhandledRejections).toEqual([])
    // The buffer and its dirty state are intact.
    expect(editor().value).toBe('unsaved edit')
    expect(screen.getByTitle('Unsaved changes')).toBeTruthy()
    // A recoverable error is surfaced in the editor UI.
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('EACCES: permission denied')

    // ...and the user can retry.
    ;(window as any).api.fbWriteFile = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      fireEvent.click(screen.getByText('Retry'))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect((window as any).api.fbWriteFile).toHaveBeenCalledWith(
      '/project',
      'src/notes.txt',
      'unsaved edit'
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTitle('Unsaved changes')).toBeNull()
  })

  it('clears dirty state and moves the saved baseline on a successful save', async () => {
    renderTab(true)
    await waitFor(() => expect(editor().value).toBe(DISK_CONTENT))

    await act(async () => {
      fireEvent.change(editor(), { target: { value: 'unsaved edit' } })
    })
    expect(screen.getByTitle('Unsaved changes')).toBeTruthy()

    const savedEvents: Event[] = []
    window.addEventListener('file-saved', e => savedEvents.push(e))

    await triggerSave()

    expect((window as any).api.fbWriteFile).toHaveBeenCalledWith(
      '/project',
      'src/notes.txt',
      'unsaved edit'
    )
    expect(screen.queryByTitle('Unsaved changes')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(savedEvents.length).toBe(1)

    // The baseline is now the saved text, not the original disk text: typing
    // the original content back in counts as a fresh unsaved change.
    await act(async () => {
      fireEvent.change(editor(), { target: { value: DISK_CONTENT } })
    })
    expect(screen.getByTitle('Unsaved changes')).toBeTruthy()
  })
})

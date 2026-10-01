// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// React import is required by the JSX runtime under vitest's default transform.
void React

const SAVE_KEYBINDING = 2048 | 49 // CtrlCmd + S
const LINK_SELECTION_KEYBINDING = 2048 | 42 // CtrlCmd + L
const LINK_FILE_KEYBINDING = 2048 | 1024 | 42 // CtrlCmd + Shift + L

const mocks = vi.hoisted(() => ({
  /** Monaco commands and actions registered on the editor, by keybinding. */
  commands: new Map<number, () => void>(),
  layoutCalls: { count: 0 },
  /** What `editor.getSelection()` returns (1-based, Monaco-style). */
  selection: null as null | { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number },
  setActiveTab: (() => {}) as (...args: unknown[]) => void,
  /** The task the editor belongs to, for agent links. */
  task: {
    id: 't1',
    tabs: { left: [] as Array<{ id: string; type: string; title: string }>, right: [] as Array<{ id: string; type: string; title: string }> },
    activeTab: { left: null as string | null, right: null as string | null }
  }
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
        addAction: (action: { keybindings?: number[]; run: () => void }) => {
          for (const keybinding of action.keybindings ?? []) mocks.commands.set(keybinding, action.run)
          return { dispose: () => {} }
        },
        getSelection: () => mocks.selection,
        onDidDispose: () => ({ dispose: () => {} }),
        onDidChangeCursorSelection: () => ({ dispose: () => {} }),
        onDidBlurEditorWidget: () => ({ dispose: () => {} }),
        hasTextFocus: () => false,
        addContentWidget: () => {},
        removeContentWidget: () => {},
        layoutContentWidget: () => {},
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

// EditorTab reads `config`, plus what agent links need to find the task's agent tab.
vi.mock('../src/renderer/context/AppContext', () => ({
  useApp: () => ({
    config: null,
    projects: [{ id: 'p1', tasks: [mocks.task] }],
    getTaskViewState: (task: typeof mocks.task) => ({ activeTab: task.activeTab, splitOpen: true }),
    setActiveTab: (...args: unknown[]) => mocks.setActiveTab(...args),
    toggleSplit: () => {}
  })
}))

import EditorTab from '../src/renderer/components/EditorTab'
import { onAgentInsert } from '../src/renderer/agentLink/linkToAgent'
import { paletteEvents } from '../src/renderer/palette/paletteEvents'

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
  mocks.selection = null
  mocks.setActiveTab = () => {}
  mocks.task.tabs = { left: [], right: [] }
  mocks.task.activeTab = { left: null, right: null }
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
  it('opens an empty file instead of staying on Loading', async () => {
    ;(window as any).api.fbReadFile = vi.fn().mockResolvedValue('')

    renderTab(true)

    await waitFor(() => expect(editor().value).toBe(''))
    expect(screen.queryByText('Loading...')).toBeNull()
  })

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

  describe('agent links', () => {
    let inserts: Array<{ tabId: string; text: string }>
    let off: () => void = () => {}

    beforeEach(() => {
      inserts = []
      off = onAgentInsert('pi-1', text => inserts.push({ tabId: 'pi-1', text }))
      mocks.task.tabs = {
        left: [{ id: 'tab-1', type: 'editor', title: 'notes.txt' }],
        right: [{ id: 'pi-1', type: 'pi', title: 'Pi' }]
      }
      mocks.task.activeTab = { left: 'tab-1', right: 'pi-1' }
    })

    afterEach(() => {
      off()
    })

    async function press(keybinding: number): Promise<void> {
      // The editor registers its commands on mount, which can land after the
      // file content shows up on a loaded runner (flaked on ubuntu CI).
      await waitFor(() => expect(mocks.commands.get(keybinding)).toBeTypeOf('function'))
      const run = mocks.commands.get(keybinding)
      await act(async () => {
        run!()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }

    it('Ctrl+L links the selected lines to the task agent tab and activates it', async () => {
      const activated: unknown[][] = []
      mocks.setActiveTab = (...args) => activated.push(args)
      renderTab(true)
      await waitFor(() => expect(editor().value).toBe(DISK_CONTENT))

      mocks.selection = { startLineNumber: 1, startColumn: 3, endLineNumber: 2, endColumn: 4 }
      await press(LINK_SELECTION_KEYBINDING)

      expect(inserts).toEqual([{ tabId: 'pi-1', text: '@src/notes.txt (lines 1-2) ' }])
      expect(activated).toEqual([['p1', 't1', 'right', 'pi-1']])
      expect((window as any).api.fbWriteFile).not.toHaveBeenCalled()
    })

    it('Ctrl+L with no selection links the cursor line', async () => {
      renderTab(true)
      await waitFor(() => expect(editor().value).toBe(DISK_CONTENT))

      mocks.selection = { startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 5 }
      await press(LINK_SELECTION_KEYBINDING)

      expect(inserts.map(i => i.text)).toEqual(['@src/notes.txt (line 2) '])
    })

    it('Ctrl+Shift+L links the whole file', async () => {
      renderTab(true)
      await waitFor(() => expect(editor().value).toBe(DISK_CONTENT))

      mocks.selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 3 }
      await press(LINK_FILE_KEYBINDING)

      expect(inserts.map(i => i.text)).toEqual(['@src/notes.txt '])
    })

    it('saves an unsaved buffer before linking, because the agent reads disk', async () => {
      renderTab(true)
      await waitFor(() => expect(editor().value).toBe(DISK_CONTENT))
      await act(async () => {
        fireEvent.change(editor(), { target: { value: 'edited\ntext\n' } })
      })

      await press(LINK_FILE_KEYBINDING)
      await flush()

      expect((window as any).api.fbWriteFile).toHaveBeenCalledWith('/project', 'src/notes.txt', 'edited\ntext\n')
      expect(inserts.map(i => i.text)).toEqual(['@src/notes.txt '])
    })

    it('sends nothing when the save fails', async () => {
      ;(window as any).api.fbWriteFile = vi.fn().mockRejectedValue(new Error('EACCES'))
      renderTab(true)
      await waitFor(() => expect(editor().value).toBe(DISK_CONTENT))
      await act(async () => {
        fireEvent.change(editor(), { target: { value: 'edited' } })
      })

      await press(LINK_FILE_KEYBINDING)
      await flush()

      expect(inserts).toEqual([])
      expect(unhandledRejections).toEqual([])
    })

    it('answers the palette only when it held focus when the palette opened', async () => {
      renderTab(true)
      await waitFor(() => expect(editor().value).toBe(DISK_CONTENT))
      mocks.selection = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 }

      const elsewhere = { kind: 'selection' as const, target: document.body, handled: false }
      await act(async () => {
        paletteEvents.emit('link-to-agent', elsewhere)
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(elsewhere.handled).toBe(false)
      expect(inserts).toEqual([])

      const here = { kind: 'selection' as const, target: editor(), handled: false }
      await act(async () => {
        paletteEvents.emit('link-to-agent', here)
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(here.handled).toBe(true)
      expect(inserts.map(i => i.text)).toEqual(['@src/notes.txt (line 2) '])
    })

    it('sends nothing when the task has no agent tab', async () => {
      mocks.task.tabs = { left: [{ id: 'tab-1', type: 'editor', title: 'notes.txt' }], right: [] }
      renderTab(true)
      await waitFor(() => expect(editor().value).toBe(DISK_CONTENT))

      await press(LINK_FILE_KEYBINDING)

      expect(inserts).toEqual([])
    })
  })
})

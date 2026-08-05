// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createHomeTask, DEFAULT_CONFIG, type Project, type Task } from '../src/shared/types'

// React import is required by the JSX runtime under vitest's default transform.
void React

const mocks = vi.hoisted(() => ({
  /** The last handler ContentArea registered for the ⌘W menu item. */
  menuCloseTab: { current: null as null | (() => void) }
}))

/** Same stand-in as tests/editor-tab.test.tsx: the buffer lives in the instance. */
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
        addCommand: () => {},
        updateOptions: () => {},
        layout: () => {}
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

// The home task's tab is irrelevant here and drags in git/stat plumbing.
vi.mock('../src/renderer/components/ProjectHome', () => ({
  ProjectHome: () => null
}))

import { AppProvider, useApp } from '../src/renderer/context/AppContext'
import { DirtyBufferProvider } from '../src/renderer/context/DirtyBufferContext'
import { TabStatusProvider } from '../src/renderer/context/TabStatusContext'
import ContentArea from '../src/renderer/components/ContentArea'
import type { AppActions } from '../src/renderer/hooks/useAppState'

const DISK: Record<string, string> = {
  'src/a.txt': 'contents of a\n',
  'src/b.txt': 'contents of b\n'
}

function editorTab(id: string, filePath: string): Task['tabs']['left'][number] {
  return { id, type: 'editor', title: filePath.split('/').pop()!, filePath }
}

function buildProjects(): Project[] {
  const { task: home } = createHomeTask('p1')
  const task: Task = {
    id: 't1',
    name: 'Task One',
    tabs: {
      left: [editorTab('tab-a', 'src/a.txt'), editorTab('tab-b', 'src/b.txt')],
      right: []
    },
    activeTab: { left: 'tab-a', right: null },
    splitOpen: false,
    splitRatio: 0.5
  }
  return [{ id: 'p1', name: 'Project One', directory: '/project', tasks: [home, task] }]
}

let app: AppActions
function Probe(): null {
  app = useApp()
  return null
}

let unhandledRejections: unknown[] = []
const recordRejection = (reason: unknown) => {
  unhandledRejections.push(reason)
}

function noopSubscribe() {
  return () => {}
}

/** Let pending promise callbacks and any unhandled-rejection reports settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function editors(): HTMLTextAreaElement[] {
  return screen.getAllByTestId('monaco') as HTMLTextAreaElement[]
}

async function type(index: number, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(editors()[index], { target: { value } })
  })
}

function tabsOf(taskId: string) {
  return app.projects.find(p => p.id === 'p1')?.tasks.find(t => t.id === taskId)?.tabs.left ?? []
}

function dialog(): HTMLElement | null {
  return screen.queryByText('Unsaved changes')
}

async function click(label: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText(label))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/**
 * Mount the real surface: AppProvider's state, ContentArea's ⌘W wiring, the
 * pane's TabBar close buttons, live EditorTabs, and the confirmation dialog.
 */
async function mountApp(): Promise<void> {
  render(
    <DirtyBufferProvider>
      <AppProvider>
        <TabStatusProvider>
          <ContentArea />
          <Probe />
        </TabStatusProvider>
      </AppProvider>
    </DirtyBufferProvider>
  )

  await waitFor(() => expect(app?.projects).toHaveLength(1))
  await act(async () => { app.switchToTask('p1', 't1') })
  await waitFor(() => expect(editors()).toHaveLength(1))
}

/** Reveal the second editor so both tabs hold a live buffer, then re-select the first. */
async function revealBothEditors(): Promise<void> {
  await act(async () => { app.setActiveTab('p1', 't1', 'left', 'tab-b') })
  await waitFor(() => expect(editors()).toHaveLength(2))
  await act(async () => { app.setActiveTab('p1', 't1', 'left', 'tab-a') })
  await flush()
}

beforeEach(() => {
  mocks.menuCloseTab.current = null
  unhandledRejections = []
  process.on('unhandledRejection', recordRejection)
  ;(window as any).api = {
    loadProjects: vi.fn().mockResolvedValue({
      revision: 0,
      data: { projects: buildProjects(), tags: [], projectOrder: ['p1'], pinnedItems: [] }
    }),
    loadConfig: vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG }),
    loadWindowState: vi.fn().mockResolvedValue(null),
    saveProjects: vi.fn().mockResolvedValue({ ok: true, revision: 1 }),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    saveWindowState: vi.fn().mockResolvedValue(undefined),
    notesLoad: vi.fn().mockResolvedValue({ revision: 0, data: {} }),
    notesSave: vi.fn().mockResolvedValue({ ok: true, revision: 1 }),
    getNativeTheme: vi.fn().mockResolvedValue('dark'),
    onThemeChanged: vi.fn().mockReturnValue(() => {}),
    onProjectsUpdated: vi.fn().mockReturnValue(() => {}),
    onNotesUpdated: vi.fn().mockReturnValue(() => {}),
    onTasksRemoved: vi.fn().mockReturnValue(() => {}),
    reportDirtyTabs: vi.fn().mockResolvedValue(undefined),
    onConfigUpdated: vi.fn().mockReturnValue(() => {}),
    onSshStatusChanged: vi.fn().mockReturnValue(() => {}),
    onSshTunnelStatusChanged: vi.fn().mockReturnValue(() => {}),
    sshStatus: vi.fn().mockResolvedValue('disconnected'),
    sshTunnelStatus: vi.fn().mockResolvedValue({ status: 'inactive' }),
    sshConnect: vi.fn().mockResolvedValue(undefined),
    sshDisconnect: vi.fn().mockResolvedValue(undefined),
    scrollbackDelete: vi.fn().mockResolvedValue(undefined),
    workspaceDelete: vi.fn().mockResolvedValue({ status: 'ok' }),
    fbGitStatus: vi.fn().mockResolvedValue(null),
    fbReadFile: vi.fn((_dir: string, filePath: string) => Promise.resolve(DISK[filePath] ?? '')),
    fbWriteFile: vi.fn().mockResolvedValue(undefined),
    onMenuCloseTab: vi.fn((cb: () => void) => {
      mocks.menuCloseTab.current = cb
      return () => {}
    }),
    onMenuReopenClosedTab: vi.fn().mockReturnValue(() => {}),
    onMenuReloadTab: vi.fn().mockReturnValue(() => {}),
    onMenuNewTerminal: vi.fn().mockReturnValue(() => {}),
    onMenuZoomIn: vi.fn().mockReturnValue(() => {}),
    onMenuZoomOut: vi.fn().mockReturnValue(() => {}),
    onMenuZoomReset: vi.fn().mockReturnValue(() => {}),
    onWindowFocusChanged: vi.fn().mockReturnValue(() => {}),
    subscribe: noopSubscribe
  }
})

afterEach(() => {
  process.off('unhandledRejection', recordRejection)
  cleanup()
  vi.restoreAllMocks()
})

describe('closing an editor with unsaved changes', () => {
  it('prompts on ⌘W and leaves the tab and its buffer alone on Cancel', async () => {
    await mountApp()
    await type(0, 'unsaved a')

    await act(async () => {
      mocks.menuCloseTab.current!()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(dialog()).toBeTruthy()
    expect(screen.getByText('src/a.txt')).toBeTruthy()

    await click('Cancel')

    expect(dialog()).toBeNull()
    expect(tabsOf('t1').map(t => t.id)).toEqual(['tab-a', 'tab-b'])
    expect(editors()[0].value).toBe('unsaved a')
    expect((window as any).api.fbWriteFile).not.toHaveBeenCalled()
  })

  it('prompts from the tab-bar close button too', async () => {
    await mountApp()
    await type(0, 'unsaved a')

    await act(async () => {
      fireEvent.click(screen.getAllByTitle('Close tab (⌘W)')[0])
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(dialog()).toBeTruthy()
    expect(screen.getByText('src/a.txt')).toBeTruthy()

    await click('Cancel')
    expect(tabsOf('t1').map(t => t.id)).toEqual(['tab-a', 'tab-b'])
    expect((window as any).api.fbWriteFile).not.toHaveBeenCalled()
  })

  it('Discard removes the tab and never touches disk', async () => {
    await mountApp()
    await type(0, 'unsaved a')

    await act(async () => {
      mocks.menuCloseTab.current!()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await click('Discard')

    expect(dialog()).toBeNull()
    expect(tabsOf('t1').map(t => t.id)).toEqual(['tab-b'])
    expect((window as any).api.fbWriteFile).not.toHaveBeenCalled()
  })

  it('Save writes the buffer and then removes the tab', async () => {
    await mountApp()
    await type(0, 'unsaved a')

    await act(async () => {
      mocks.menuCloseTab.current!()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await click('Save')

    expect((window as any).api.fbWriteFile).toHaveBeenCalledWith('/project', 'src/a.txt', 'unsaved a')
    expect(dialog()).toBeNull()
    expect(tabsOf('t1').map(t => t.id)).toEqual(['tab-b'])
  })

  it('keeps the tab and surfaces the error when the save fails', async () => {
    await mountApp()
    await type(0, 'unsaved a')
    ;(window as any).api.fbWriteFile = vi.fn().mockRejectedValue(
      new Error("EACCES: permission denied, open '/project/src/a.txt'")
    )

    await act(async () => {
      mocks.menuCloseTab.current!()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await click('Save')
    await flush()

    // Nothing escaped to main.tsx's unhandled-rejection crash screen.
    expect(unhandledRejections).toEqual([])
    // The removal is not done, the dialog stays up with the reason...
    expect(dialog()).toBeTruthy()
    const card = dialog()!.closest('header')!.parentElement!
    expect(within(card).getByText(/EACCES: permission denied/)).toBeTruthy()
    expect(tabsOf('t1').map(t => t.id)).toEqual(['tab-a', 'tab-b'])
    // ...and the buffer is still there to retry or copy out.
    expect(editors()[0].value).toBe('unsaved a')

    // Backing out of the dialog still keeps everything.
    await click('Cancel')
    expect(dialog()).toBeNull()
    expect(tabsOf('t1').map(t => t.id)).toEqual(['tab-a', 'tab-b'])
  })

  it('asks once for a task holding two dirty editors, and Cancel deletes nothing', async () => {
    await mountApp()
    await revealBothEditors()
    await type(0, 'unsaved a')
    await type(1, 'unsaved b')

    await act(async () => {
      void app.removeTask('p1', 't1')
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(screen.getAllByText('Unsaved changes')).toHaveLength(1)
    expect(screen.getByText('src/a.txt')).toBeTruthy()
    expect(screen.getByText('src/b.txt')).toBeTruthy()

    await click('Cancel')

    expect(app.projects[0].tasks.map(t => t.id)).toContain('t1')
    expect(tabsOf('t1').map(t => t.id)).toEqual(['tab-a', 'tab-b'])
    expect((window as any).api.fbWriteFile).not.toHaveBeenCalled()
    expect((window as any).api.workspaceDelete).not.toHaveBeenCalled()
  })

  it('asks once for a project holding dirty editors, and Cancel deletes nothing', async () => {
    await mountApp()
    await revealBothEditors()
    await type(0, 'unsaved a')
    await type(1, 'unsaved b')

    await act(async () => {
      void app.removeProject('p1')
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(screen.getAllByText('Unsaved changes')).toHaveLength(1)
    expect(screen.getByText('src/a.txt')).toBeTruthy()
    expect(screen.getByText('src/b.txt')).toBeTruthy()

    await click('Cancel')

    expect(app.projects.map(p => p.id)).toEqual(['p1'])
    expect(tabsOf('t1').map(t => t.id)).toEqual(['tab-a', 'tab-b'])
    expect((window as any).api.fbWriteFile).not.toHaveBeenCalled()

    // Discarding does go through, for the whole project at once.
    await act(async () => {
      void app.removeProject('p1')
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await click('Discard')
    expect(app.projects).toHaveLength(0)
    expect((window as any).api.fbWriteFile).not.toHaveBeenCalled()
  })

  it('closes a clean tab exactly as before — no dialog, no write', async () => {
    await mountApp()

    await act(async () => {
      mocks.menuCloseTab.current!()
    })

    expect(dialog()).toBeNull()
    expect(tabsOf('t1').map(t => t.id)).toEqual(['tab-b'])
    expect((window as any).api.fbWriteFile).not.toHaveBeenCalled()
  })
})

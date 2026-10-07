// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_CONFIG, mainStreamId, type Project, type ProjectsData, type Tab, type Task } from '../src/shared/types'
import { projectTasks } from '../src/shared/streams'
import { fixtureProject } from './helpers/streams-fixtures'
import { AppProvider } from '../src/renderer/context/AppContext'
import { TabStatusProvider } from '../src/renderer/context/TabStatusContext'
import Sidebar from '../src/renderer/components/Sidebar'
import { projectDeletePrompt, revealFolder } from '../src/renderer/components/sidebar/SidebarContextMenu'

// React import is required by the JSX runtime under vitest's default transform.
void React

/**
 * Smoke test for the sidebar after its context menu, row parts and drag logic
 * moved out into `components/sidebar/`: the full tree renders against the real
 * app state, and the extracted menu still drives app actions.
 */

function buildProjects(): Project[] {
  const work: Task = { id: 't1', name: 'Fix the thing', panes: [] }
  return [fixtureProject({ id: 'p1', name: 'Alpha Project', directory: '/tmp/alpha', tasks: [work] })]
}

let saved: ProjectsData[]
let pinnedItems: ProjectsData['pinnedItems']
let projectsFixture: () => Project[]
// Quiet streams fold by default; most tests here want the rows on screen.
let configOverrides: Partial<typeof DEFAULT_CONFIG>

beforeEach(() => {
  saved = []
  pinnedItems = []
  projectsFixture = buildProjects
  configOverrides = { autoCollapseQuietStreams: false }
  const known: Record<string, unknown> = {
    loadProjects: vi.fn().mockImplementation(async () => ({
      revision: 0,
      data: { projects: projectsFixture(), tags: [], projectOrder: projectsFixture().map(p => p.id), pinnedItems }
    })),
    loadConfig: vi.fn().mockImplementation(async () => ({ ...DEFAULT_CONFIG, ...configOverrides })),
    loadWindowState: vi.fn().mockResolvedValue({ expandedProjectIds: ['p1'], sidebarTab: 'projects' }),
    notesLoad: vi.fn().mockResolvedValue({ revision: 0, data: {} }),
    saveProjects: vi.fn().mockImplementation((payload: { data: ProjectsData }) => {
      saved.push(payload.data)
      return Promise.resolve({ ok: true, revision: saved.length })
    }),
    getNativeTheme: vi.fn().mockResolvedValue('dark'),
    sshStatus: vi.fn().mockResolvedValue('disconnected'),
    getAgentActivity: vi.fn().mockResolvedValue({})
  }
  // Everything else the tree touches is a listener (returns a cleanup) or a
  // fire-and-forget call.
  ;(window as any).api = new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      const fn = prop.startsWith('on') ? vi.fn(() => () => {}) : vi.fn(() => Promise.resolve(undefined))
      target[prop] = fn
      return fn
    }
  })
  // dashboard icon metadata fetch
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderSidebar() {
  return render(
    <TabStatusProvider>
      <AppProvider>
        <Sidebar />
      </AppProvider>
    </TabStatusProvider>
  )
}

describe('Sidebar context menu', () => {
  it('opens on a task row and settles the task', async () => {
    renderSidebar()
    const row = await screen.findByText('Fix the thing')

    fireEvent.contextMenu(row)
    // By text: the row's own hover action is also a button titled 'Settle'.
    const settle = await screen.findByText('Settle', { selector: 'button' })
    act(() => { fireEvent.click(settle) })

    await waitFor(() => {
      const task = projectTasks(saved[saved.length - 1]?.projects[0]).find(t => t.id === 't1')
      expect(task?.inbox?.settledAt).toBeTypeOf('number')
    })
    expect(screen.queryByText('Settle', { selector: 'button' })).toBeNull()
  })

  it('pages to the snooze presets and back out on dismiss', async () => {
    renderSidebar()
    fireEvent.contextMenu(await screen.findByText('Fix the thing'))
    fireEvent.click(await screen.findByRole('button', { name: /Snooze/ }))

    // The presets replace the menu body.
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0)

    act(() => { window.dispatchEvent(new MouseEvent('mousedown')) })
    expect(screen.queryByRole('button', { name: /Snooze/ })).toBeNull()
  })

  it('shows project details and pins a project', async () => {
    renderSidebar()
    await screen.findByText('Alpha Project')
    fireEvent.contextMenu(document.querySelector('[data-drag-type="project"][data-drag-id="p1"]')!)

    expect((await screen.findByTitle('/tmp/alpha')).textContent).toBe('Dir: /tmp/alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Pin project' }))

    await waitFor(() => {
      expect(saved[saved.length - 1]?.pinnedItems).toEqual([{ type: 'project', projectId: 'p1' }])
    })
  })

  it('closes an idle task without asking', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    renderSidebar()
    fireEvent.contextMenu(await screen.findByText('Fix the thing'))
    fireEvent.click(await screen.findByText('Close task', { selector: 'button' }))
    await waitFor(() => {
      expect(saved.length).toBeGreaterThan(0)
      expect(projectTasks(saved[saved.length - 1].projects[0]).some(t => t.id === 't1')).toBe(false)
    })
    expect(confirm).not.toHaveBeenCalled()
    // main is emptied, never removed.
    expect(saved[saved.length - 1]?.projects[0].streams.map(st => st.id)).toEqual([mainStreamId('p1')])
  })

  it('asks before deleting a project, and reveals its folder', async () => {
    const confirm = vi.fn((_message: string) => false)
    vi.stubGlobal('confirm', confirm)
    renderSidebar()
    await screen.findByText('Alpha Project')
    const row = document.querySelector('[data-drag-type="project"][data-drag-id="p1"]')!
    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete…' }))
    expect(confirm.mock.calls[0][0]).toMatch(/^Delete project "Alpha Project"\?[\s\S]*Its task closes[\s\S]*not touched/)
    expect(screen.getByText('Alpha Project')).toBeTruthy()

    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByRole('button', { name: /Reveal in Finder|Show in/ }))
    expect(window.api.revealInFolder).toHaveBeenCalledWith('/tmp/alpha')
  })
})

describe('Sidebar pins', () => {
  const lastTasks = () => projectTasks(saved[saved.length - 1]?.projects[0])

  it('adds a task and opens the new-stream dialog from a pinned project', async () => {
    pinnedItems = [{ type: 'project', projectId: 'p1' }]
    renderSidebar()
    const pinned = (await screen.findByText('Pinned')).parentElement!
    fireEvent.click(within(pinned).getByTitle('New task'))
    await waitFor(() => expect(lastTasks()).toHaveLength(2))
    expect(lastTasks()[1]).toMatchObject({ name: 'New Task' })
    expect(lastTasks()[1]).not.toHaveProperty('workspaceDraft')

    fireEvent.click(within(pinned).getByTitle('New stream'))
    expect(await screen.findByText('New stream in Alpha Project')).toBeTruthy()
  })

  it('adds a sibling task from a pinned task, in its stream', async () => {
    pinnedItems = [{ type: 'task', projectId: 'p1', streamId: mainStreamId('p1'), taskId: 't1' }]
    renderSidebar()
    const pinned = (await screen.findByText('Pinned')).parentElement!
    fireEvent.click(within(pinned).getByTitle('New task in main'))
    await waitFor(() => expect(lastTasks()).toHaveLength(2))
  })

  it('offers + Task and + Stream under an expanded pinned project', async () => {
    pinnedItems = [{ type: 'project', projectId: 'p1' }]
    renderSidebar()
    const pinned = (await screen.findByText('Pinned')).parentElement!
    expect(within(pinned).queryByText('Stream')).toBeNull()
    fireEvent.click(pinned.querySelector('[data-pin-key] button')!)
    fireEvent.click(within(pinned).getByText('Stream'))
    expect(await screen.findByText('New stream in Alpha Project')).toBeTruthy()
  })

  it('creates a project-folder stream from a project\'s context menu', async () => {
    renderSidebar()
    await screen.findByText('Alpha Project')
    fireEvent.contextMenu(document.querySelector('[data-drag-type="project"][data-drag-id="p1"]')!)
    fireEvent.click(await screen.findByRole('button', { name: 'New stream…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Project folder' }))
    fireEvent.change(screen.getByLabelText('Stream name'), { target: { value: 'bugfixes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create stream' }))
    await waitFor(() => expect(saved[saved.length - 1]?.projects[0].streams.map(st => st.name)).toEqual(['main', 'bugfixes']))
    expect(saved[saved.length - 1]?.projects[0].streams[1]).not.toHaveProperty('workspace')
  })
})

describe('revealFolder / projectDeletePrompt', () => {
  const project: Project = fixtureProject({
    id: 'p1',
    name: 'Alpha',
    directory: '/repo',
    tasks: [
      { ...projectTasks(buildProjects()[0])[0], id: 'w1', workspace: { worktreePath: '/wt/feat', branchName: 'feat', baseBranch: 'main', relativeProjectPath: 'pkg' } }
    ]
  })
  it('uses the workspace for a workspace task and the project dir otherwise', () => {
    expect(revealFolder([project], 'p1')).toBe('/repo')
    expect(revealFolder([project], 'p1', 'w1')).toBe('/wt/feat/pkg')
    expect(revealFolder([{ ...project, ssh: { host: 'h', port: 22, username: 'u', remoteDir: '/x' } as never }], 'p1')).toBeNull()
  })
  it('names the worktrees a project delete removes', () => {
    expect(projectDeletePrompt(project)).toMatch(/Its task closes[\s\S]*workspace worktree is removed from disk/)
  })
})

describe('Sidebar stream tree', () => {
  const tab = (id: string, type: 'claude' | 'terminal' | 'browser'): Tab => ({ id, type, title: id } as Tab)
  const worktree = { worktreePath: '/wt/rel', branchName: 'release-0.5', baseBranch: 'main', relativeProjectPath: '' }
  function treeProjects(): Project[] {
    return [fixtureProject({
      id: 'p1',
      name: 'Alpha Project',
      directory: '/tmp/alpha',
      tasks: [
        { id: 'quiet', name: 'Quiet task' },
        { id: 'busy', name: 'Busy task', tabs: { left: [tab('a1', 'claude'), tab('t1', 'terminal'), tab('b1', 'browser')] }, workspace: worktree }
      ]
    })].map(project => ({
      ...project,
      // The worktree stream gets a name of its own.
      streams: project.streams.map(stream => (stream.workspace ? { ...stream, name: '0.5.0' } : stream))
    }))
  }
  const lastProject = () => saved[saved.length - 1]?.projects[0]
  const streamRow = (id: string) => document.querySelector<HTMLElement>(`[data-tree-row="stream"][data-stream-id="${id}"]`)!

  beforeEach(() => {
    projectsFixture = treeProjects
  })

  it('lists streams with their branch and tasks with their extra tabs', async () => {
    renderSidebar()
    await screen.findByText('Busy task')
    expect(streamRow(mainStreamId('p1')).textContent).toContain('main')
    expect(streamRow('stream-busy').textContent).toContain('⎇ release-0.5')
    expect(screen.getByText('+2')).toBeTruthy()
    // Terminals and browsers are tabs inside the task, never rows.
    expect(screen.queryByText('t1')).toBeNull()
    expect(screen.queryByText('b1')).toBeNull()
  })

  it('folds quiet streams when auto-collapse is on, and a click opens one', async () => {
    configOverrides = {}
    renderSidebar()
    await screen.findByText('Alpha Project')
    await waitFor(() => expect(streamRow(mainStreamId('p1'))).toBeTruthy())
    expect(screen.queryByText('Quiet task')).toBeNull()
    // The collapsed row says how many tasks it holds.
    expect(streamRow(mainStreamId('p1')).textContent).toContain('1')

    fireEvent.click(streamRow(mainStreamId('p1')))
    expect(await screen.findByText('Quiet task')).toBeTruthy()
  })

  it('never offers ✕ on main; a clean worktree stream closes without asking', async () => {
    const confirm = vi.fn((_message: string) => true)
    vi.stubGlobal('confirm', confirm)
    ;(window.api as unknown as Record<string, unknown>).workspaceDelete = vi.fn().mockResolvedValue({ status: 'ok' })
    renderSidebar()
    await screen.findByText('Busy task')
    expect(within(streamRow(mainStreamId('p1'))).queryByTitle('Close stream')).toBeNull()

    fireEvent.click(within(streamRow('stream-busy')).getByTitle('Close stream'))
    await waitFor(() => expect(lastProject()?.streams.map(s => s.id)).toEqual([mainStreamId('p1')]))
    expect(confirm).not.toHaveBeenCalled()
    // Only the pre-flight ran: clean and merged, it removed the worktree itself.
    expect(window.api.workspaceDelete).toHaveBeenCalledTimes(1)
    expect(window.api.workspaceDelete).toHaveBeenLastCalledWith(expect.not.objectContaining({ force: true }))
  })

  it('asks keep branch / discard / cancel when the worktree has work', async () => {
    const workspaceDelete = vi.fn().mockResolvedValue({ status: 'unmerged', baseBranch: 'main' })
    ;(window.api as unknown as Record<string, unknown>).workspaceDelete = workspaceDelete
    renderSidebar()
    await screen.findByText('Busy task')

    fireEvent.click(within(streamRow('stream-busy')).getByTitle('Close stream'))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Keep branch' })).toBeNull())
    expect(lastProject()?.streams.map(s => s.id) ?? ['unchanged']).not.toEqual([mainStreamId('p1')])

    workspaceDelete.mockResolvedValueOnce({ status: 'unmerged', baseBranch: 'main' }).mockResolvedValueOnce({ status: 'ok' })
    fireEvent.click(within(streamRow('stream-busy')).getByTitle('Close stream'))
    expect(await screen.findByText(/not merged into "main"/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep branch' }))
    await waitFor(() => expect(lastProject()?.streams.map(s => s.id)).toEqual([mainStreamId('p1')]))
    await waitFor(() => expect(workspaceDelete).toHaveBeenLastCalledWith(expect.objectContaining({ force: true, keepBranch: true })))
  })

  it('adds a task to a stream from its row', async () => {
    renderSidebar()
    await screen.findByText('Busy task')
    fireEvent.click(within(streamRow('stream-busy')).getByTitle('New task in 0.5.0'))
    await waitFor(() => expect(lastProject()?.streams.find(s => s.id === 'stream-busy')?.tasks).toHaveLength(2))
  })

  it('pins a stream from its menu and lists its tasks under the pin', async () => {
    renderSidebar()
    await screen.findByText('Busy task')
    fireEvent.contextMenu(streamRow('stream-busy'))
    fireEvent.click(await screen.findByRole('button', { name: 'Pin stream' }))
    await waitFor(() => {
      expect(saved[saved.length - 1]?.pinnedItems).toEqual([{ type: 'stream', projectId: 'p1', streamId: 'stream-busy' }])
    })
    const pinned = (await screen.findByText('Pinned')).parentElement!
    expect(within(pinned).getByText('Busy task')).toBeTruthy()
    expect(within(pinned).queryByText('Quiet task')).toBeNull()
  })
})

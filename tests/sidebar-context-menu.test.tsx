// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_CONFIG, mainStreamId, type Project, type ProjectsData, type Tab, type Task } from '../src/shared/types'
import { projectTasks } from '../src/shared/streams'
import { fixtureProject } from './helpers/streams-fixtures'
import { AppProvider, useApp } from '../src/renderer/context/AppContext'
import { TabStatusProvider } from '../src/renderer/context/TabStatusContext'
import Sidebar from '../src/renderer/components/Sidebar'
import EntityActionsHost from '../src/renderer/components/EntityActionsHost'
import { projectDeletePrompt, revealFolder } from '../src/renderer/components/sidebar/SidebarContextMenu'
import { EntityMenuPopup, type EntityMenuTarget } from '../src/renderer/components/menus/EntityMenus'

// React import is required by the JSX runtime under vitest's default transform.
void React

/**
 * The inbox column against the real app state: a row's menu (and its stream,
 * project and move pages) drives app actions, and the project and stream menus
 * (the task header's and the Project map's) do too, opened here from a harness.
 */

function buildProjects(): Project[] {
  const work: Task = { id: 't1', name: 'Fix the thing', panes: [] }
  return [fixtureProject({ id: 'p1', name: 'Alpha Project', directory: '/tmp/alpha', tasks: [work] })]
}

let saved: ProjectsData[]
let pinnedItems: ProjectsData['pinnedItems']
let projectsFixture: () => Project[]

beforeEach(() => {
  saved = []
  pinnedItems = []
  projectsFixture = buildProjects
  const known: Record<string, unknown> = {
    loadProjects: vi.fn().mockImplementation(async () => ({ local: {
      revision: 0,
      data: { projects: projectsFixture(), tags: [], projectOrder: projectsFixture().map(p => p.id), pinnedItems }
    } })),
    loadConfig: vi.fn().mockImplementation(async () => ({ ...DEFAULT_CONFIG })),
    notesLoad: vi.fn().mockResolvedValue({ revision: 0, data: {} }),
    saveProjects: vi.fn().mockImplementation((_source: string, payload: { data: ProjectsData }) => {
      saved.push(payload.data)
      return Promise.resolve({ ok: true, revision: saved.length })
    }),
    getNativeTheme: vi.fn().mockResolvedValue('dark'),
    sshStatus: vi.fn().mockResolvedValue('disconnected'),
    getAgentActivity: vi.fn().mockResolvedValue({})
  }
  // Everything else the column touches is a listener (returns a cleanup) or a
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

/** Buttons that open a project's or a stream's menu, as the task header and the Project map do. */
function MenuHarness(): React.ReactElement {
  const { projects } = useApp()
  const [menu, setMenu] = useState<EntityMenuTarget | null>(null)
  return (
    <>
      {projects.map(project => (
        <React.Fragment key={project.id}>
          <button data-testid={`open-project-${project.id}`} onClick={() => setMenu({ x: 0, y: 0, kind: 'project', projectId: project.id })}>{project.name}</button>
          {project.streams.map(stream => (
            <button key={stream.id} data-testid={`open-stream-${stream.id}`} onClick={() => setMenu({ x: 0, y: 0, kind: 'stream', projectId: project.id, streamId: stream.id })}>{stream.name}</button>
          ))}
        </React.Fragment>
      ))}
      <EntityMenuPopup menu={menu} onClose={() => setMenu(null)} />
    </>
  )
}

function renderSidebar() {
  return render(
    <TabStatusProvider>
      <AppProvider>
        <Sidebar />
        <MenuHarness />
        <EntityActionsHost />
      </AppProvider>
    </TabStatusProvider>
  )
}

/** A project's menu, from the harness (closing any menu open before). */
async function openProjectMenu(projectId: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId(`open-project-${projectId}`))
  return screen.findByTestId('project-menu')
}

/** A desk row by its task's name. */
async function row(name: string): Promise<HTMLElement> {
  const title = await screen.findByText(name, { selector: '[data-testid="desk-row-title"]' })
  return title.closest<HTMLElement>('[data-testid="desk-row"]')!
}

describe('Inbox row menu and project menu', () => {
  it('opens on a task row and snoozes the task until it needs you', async () => {
    renderSidebar()
    fireEvent.contextMenu(await row('Fix the thing'))
    fireEvent.click((await screen.findAllByRole('button', { name: /Snooze/ })).at(-1)!)
    expect(screen.queryByText('Done for now', { selector: 'button' })).toBeNull()
    act(() => { fireEvent.click(screen.getByText('Until it needs me')) })

    await waitFor(() => {
      const task = projectTasks(saved[saved.length - 1]?.projects[0]).find(t => t.id === 't1')
      expect(task?.inbox?.snoozeUntilAttention).toBe(true)
    })
    expect(screen.queryByText('Until it needs me')).toBeNull()
  })

  it('pages to the snooze presets and back out on dismiss', async () => {
    renderSidebar()
    fireEvent.contextMenu(await row('Fix the thing'))
    fireEvent.click((await screen.findAllByRole('button', { name: /Snooze/ })).at(-1)!)

    // The presets replace the menu body.
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0)

    expect(screen.getByText('Until it needs me')).toBeTruthy()
    act(() => { window.dispatchEvent(new MouseEvent('mousedown')) })
    expect(screen.queryByText('Until it needs me')).toBeNull()
  })

  it('shows project details and pins a project', async () => {
    renderSidebar()
    await openProjectMenu('p1')
    expect((await screen.findByTitle('/tmp/alpha')).textContent).toBe('Dir: /tmp/alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Pin project' }))

    await waitFor(() => {
      expect(saved[saved.length - 1]?.pinnedItems).toEqual([{ type: 'project', projectId: 'p1' }])
    })
  })

  it('offers Move to a DevTool server on SSH projects only, and opens its dialog', async () => {
    const server = 'a'.repeat(32)
    const ssh = { ...fixtureProject({ id: 'p-ssh', name: 'Remote Repo', directory: '' }), ssh: { host: 'box', port: 22, username: 'me', remoteDir: '/home/me/repo' } }
    const onServer = fixtureProject({ id: 'p-srv', name: 'Server Repo', directory: '/srv/repo' })
    ;(window as any).api.loadProjects = vi.fn().mockResolvedValue({
      local: { revision: 0, data: { projects: [...buildProjects(), ssh], tags: [], projectOrder: ['p1', 'p-ssh', 'p-srv'], pinnedItems: [] } },
      [server]: { revision: 1, data: { projects: [onServer], tags: [], projectOrder: [], pinnedItems: [] } }
    })
    renderSidebar()
    const menuFor = async (projectId: string) => {
      await openProjectMenu(projectId)
      await screen.findByRole('button', { name: /^Rename/ })
      return screen.queryByRole('button', { name: 'Move to a DevTool server…' })
    }
    expect(await menuFor('p1')).toBeNull()
    // A folder project renames through the dialog (folder too); an SSH one by name only.
    expect(screen.getByRole('button', { name: 'Rename…' })).toBeTruthy()
    expect(await menuFor('p-srv')).toBeNull()
    const move = await menuFor('p-ssh')
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy()
    expect(move).toBeTruthy()
    fireEvent.click(move!)
    expect(await screen.findByText('Move Remote Repo to a DevTool server')).toBeTruthy()
    expect(window.api.serversSshProbe).toHaveBeenCalledWith('p-ssh')
    expect(screen.getByTestId('move-summary').textContent).toContain('The SSH project goes away.')
  })

  it('closes an idle task without asking', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    renderSidebar()
    fireEvent.contextMenu(await row('Fix the thing'))
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
    await openProjectMenu('p1')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete…' }))
    expect(confirm.mock.calls[0][0]).toMatch(/^Delete project "Alpha Project"\?[\s\S]*Its task closes[\s\S]*not touched/)
    expect(screen.getByTestId('open-project-p1')).toBeTruthy()

    await openProjectMenu('p1')
    fireEvent.click(await screen.findByRole('button', { name: /Reveal in Finder|Show in/ }))
    expect(window.api.revealInFolder).toHaveBeenCalledWith('/tmp/alpha', undefined, 'p1')
  })

  it('opens Rename… for a folder project and renames it with its folder', async () => {
    const check = vi.fn().mockResolvedValue({ target: '/tmp/beta', blockers: [], running: { terminals: 0, agents: 0, chats: 0 } })
    const rename = vi.fn().mockResolvedValue({ directory: '/tmp/beta', warnings: [] })
    ;(window.api as unknown as Record<string, unknown>).renameProjectCheck = check
    ;(window.api as unknown as Record<string, unknown>).renameProjectFolder = rename
    renderSidebar()
    await openProjectMenu('p1')
    fireEvent.click(await screen.findByRole('button', { name: 'Rename…' }))
    expect(await screen.findByText('Rename Project')).toBeTruthy()
    // "Alpha Project" isn't the folder's name (alpha), so the folder stays unless switched on.
    fireEvent.change(screen.getByDisplayValue('Alpha Project'), { target: { value: 'Beta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(saved[saved.length - 1]?.projects[0].name).toBe('Beta'))
    expect(rename).not.toHaveBeenCalled()
  })

  it('marks a project whose folder is gone in the scope menu, and offers no folder to trash', async () => {
    ;(window.api as unknown as Record<string, unknown>).missingProjectDirs = vi.fn().mockResolvedValue(['p1'])
    renderSidebar()
    await row('Fix the thing')
    fireEvent.click(screen.getByTestId('desk-scope'))
    const menu = await screen.findByTestId('desk-scope-menu')
    await waitFor(() => expect(menu.querySelector('[title^="Folder not found"]')?.getAttribute('title')).toContain('/tmp/alpha'))
    await openProjectMenu('p1')
    await screen.findByRole('button', { name: 'Delete…' })
    expect(screen.queryByRole('button', { name: 'Delete with folder…' })).toBeNull()
  })

  it('deletes a project with its folder after asking, trashing the folder last', async () => {
    const confirm = vi.fn((_message: string) => true)
    vi.stubGlobal('confirm', confirm)
    const trash = vi.fn().mockResolvedValue(undefined)
    ;(window.api as unknown as Record<string, unknown>).trashProjectDir = trash
    renderSidebar()
    await openProjectMenu('p1')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete with folder…' }))
    expect(confirm.mock.calls[0][0]).toMatch(/\/tmp\/alpha is moved to the Trash/)
    expect(confirm.mock.calls[0][0]).not.toMatch(/not touched/)
    await waitFor(() => expect(trash).toHaveBeenCalledTimes(2))
    expect(trash.mock.calls).toEqual([['p1', true], ['p1']])
    await waitFor(() => expect(saved[saved.length - 1]?.projects.some(p => p.id === 'p1')).toBe(false))
  })

  it('keeps the project when main refuses to trash its folder', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    const trash = vi.fn().mockRejectedValue(new Error('Refusing to trash /tmp/alpha: project "B" lives in it too.'))
    ;(window.api as unknown as Record<string, unknown>).trashProjectDir = trash
    renderSidebar()
    await openProjectMenu('p1')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete with folder…' }))
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringMatching(/^Nothing was deleted\. Refusing/)))
    expect(trash).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('open-project-p1')).toBeTruthy()
  })

  it('creates a project-folder stream from a project\'s menu', async () => {
    renderSidebar()
    await openProjectMenu('p1')
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

describe('Streams from the column and their menus', () => {
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
  const openStreamMenu = async (streamId: string): Promise<HTMLElement> => {
    fireEvent.click(await screen.findByTestId(`open-stream-${streamId}`))
    return screen.findByTestId('stream-menu')
  }

  beforeEach(() => {
    projectsFixture = treeProjects
  })

  it('names a row\'s stream unless it is main', async () => {
    renderSidebar()
    expect((await row('Busy task')).textContent).toContain('0.5.0')
    expect((await row('Quiet task')).textContent).not.toContain('main')
  })

  it('never offers Close on main; a clean worktree stream closes without asking', async () => {
    const confirm = vi.fn((_message: string) => true)
    vi.stubGlobal('confirm', confirm)
    ;(window.api as unknown as Record<string, unknown>).workspaceDelete = vi.fn().mockResolvedValue({ status: 'ok' })
    renderSidebar()
    await row('Busy task')
    expect(within(await openStreamMenu(mainStreamId('p1'))).queryByRole('button', { name: 'Close stream' })).toBeNull()

    fireEvent.click(within(await openStreamMenu('stream-busy')).getByRole('button', { name: 'Close stream' }))
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
    await row('Busy task')

    fireEvent.click(within(await openStreamMenu('stream-busy')).getByRole('button', { name: 'Close stream' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Keep branch' })).toBeNull())
    expect(lastProject()?.streams.map(s => s.id) ?? ['unchanged']).not.toEqual([mainStreamId('p1')])

    workspaceDelete.mockResolvedValueOnce({ status: 'unmerged', baseBranch: 'main' }).mockResolvedValueOnce({ status: 'ok' })
    fireEvent.click(within(await openStreamMenu('stream-busy')).getByRole('button', { name: 'Close stream' }))
    expect(await screen.findByText(/not merged into "main"/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep branch' }))
    await waitFor(() => expect(lastProject()?.streams.map(s => s.id)).toEqual([mainStreamId('p1')]))
    await waitFor(() => expect(workspaceDelete).toHaveBeenLastCalledWith(expect.objectContaining({ force: true, keepBranch: true })))
  })

  it('adds a task to a stream from its menu', async () => {
    renderSidebar()
    await row('Busy task')
    fireEvent.click(within(await openStreamMenu('stream-busy')).getByRole('button', { name: 'New task in 0.5.0' }))
    await waitFor(() => expect(lastProject()?.streams.find(s => s.id === 'stream-busy')?.tasks).toHaveLength(2))
  })

  it('opens the task\'s stream menu as a page, and renames the stream in a dialog', async () => {
    renderSidebar()
    fireEvent.contextMenu(await row('Busy task'))
    fireEvent.click(await screen.findByTestId('task-menu-open-stream'))
    const page = await screen.findByTestId('task-menu-stream')
    expect(within(page).getByTestId('stream-menu-header').textContent).toContain('0.5.0')
    for (const name of ['New task here', 'Commands…', 'Rename', 'Pin stream', 'Close stream']) {
      expect(within(page).getByRole('button', { name })).toBeTruthy()
    }
    fireEvent.click(within(page).getByRole('button', { name: 'Rename' }))
    const input = await screen.findByLabelText('Stream name')
    fireEvent.change(input, { target: { value: 'release' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(lastProject()?.streams.find(s => s.id === 'stream-busy')?.name).toBe('release'))
  })

  it('offers no Close on main\'s page, and goes back to the task menu', async () => {
    renderSidebar()
    fireEvent.contextMenu(await row('Quiet task'))
    fireEvent.click(await screen.findByTestId('task-menu-open-stream'))
    const page = await screen.findByTestId('task-menu-stream')
    expect(within(page).queryByRole('button', { name: 'Close stream' })).toBeNull()
    fireEvent.click(within(page).getByRole('button', { name: 'Quiet task' }))
    expect(await screen.findByTestId('task-menu-open-project')).toBeTruthy()
  })

  it('opens Project Settings from the task\'s project page', async () => {
    renderSidebar()
    fireEvent.contextMenu(await row('Quiet task'))
    fireEvent.click(await screen.findByTestId('task-menu-open-project'))
    const page = await screen.findByTestId('task-menu-project')
    expect(within(page).getByRole('button', { name: 'Rename…' })).toBeTruthy()
    expect(within(page).getByRole('button', { name: 'Delete…' })).toBeTruthy()
    fireEvent.click(within(page).getByRole('button', { name: 'Settings' }))
    expect(await screen.findByText('Project Settings')).toBeTruthy()
  })

  it('moves a task to another stream from its menu, asking first when its folder changes', async () => {
    const confirm = vi.fn((_message: string) => true)
    vi.stubGlobal('confirm', confirm)
    renderSidebar()
    fireEvent.contextMenu(await row('Quiet task'))
    fireEvent.click(await screen.findByTestId('task-menu-open-move'))
    const page = await screen.findByTestId('task-menu-move')
    expect(within(page).queryByTestId(`move-to-stream-${mainStreamId('p1')}`)).toBeNull()
    fireEvent.click(within(page).getByTestId('move-to-stream-stream-busy'))
    expect(confirm.mock.calls[0][0]).toMatch(/^Move "Quiet task" to 0\.5\.0\?[\s\S]*release-0\.5 worktree/)
    await waitFor(() => expect(lastProject()?.streams.find(s => s.id === 'stream-busy')?.tasks.map(t => t.id)).toEqual(['busy', 'quiet']))
  })

  it('pins a stream from its menu and offers it first in the scope menu', async () => {
    renderSidebar()
    await row('Busy task')
    fireEvent.click(within(await openStreamMenu('stream-busy')).getByRole('button', { name: 'Pin stream' }))
    await waitFor(() => {
      expect(saved[saved.length - 1]?.pinnedItems).toEqual([{ type: 'stream', projectId: 'p1', streamId: 'stream-busy' }])
    })
    fireEvent.click(screen.getByTestId('desk-scope'))
    const pinned = await screen.findByTestId('desk-scope-pinned-stream')
    expect(pinned.textContent).toContain('0.5.0')
    fireEvent.click(pinned)
    await waitFor(() => expect(screen.queryByText('Quiet task', { selector: '[data-testid="desk-row-title"]' })).toBeNull())
    expect(await row('Busy task')).toBeTruthy()
  })

  it('pins a task from its row menu: it goes first in its group, with a pin', async () => {
    renderSidebar()
    await row('Busy task')
    fireEvent.contextMenu(await row('Quiet task'))
    fireEvent.click(await screen.findByRole('button', { name: 'Pin task' }))
    await waitFor(() => expect(saved[saved.length - 1]?.pinnedItems).toEqual([{ type: 'task', projectId: 'p1', streamId: mainStreamId('p1'), taskId: 'quiet' }]))
    expect(await within(await row('Quiet task')).findByLabelText('pinned')).toBeTruthy()
  })
})

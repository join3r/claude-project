import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, isSpentEphemeralProject, mainStreamId, resolveStoredSelection, type Project, type Tab, type Task } from '../src/shared/types'
import { dropHomeTasks, migrateProjects } from '../src/shared/streams-migration'
import { selectProjectHomeView } from '../src/renderer/hooks/appState/viewState'
import { resolveLandingTaskId } from '../src/renderer/hooks/taskNavigation'
import { createDefaultWindowViewState } from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

/*
 * Home is a project page (the project selected with no task), not a task. Builds
 * between the streams migration and this one kept a `system: 'home'` task at the
 * front of `main`; loading drops it.
 */

const homeTab = (projectId: string): Tab =>
  ({ id: `home-tab-${projectId}`, type: 'home', title: 'Home', system: 'home' }) as unknown as Tab

/** A Home task as the step-2 build wrote it, with `extra` tabs opened next to Home. */
function homeTask(projectId: string, extra: Tab[] = [], activeTabId?: string): Task {
  const tabs = [homeTab(projectId), ...extra]
  return {
    id: `home-task-${projectId}`,
    name: 'Home',
    panes: [{ tabs, activeTabId: activeTabId ?? tabs[0].id, width: 1 }],
    lastInteractedAt: 1_000,
    system: 'home'
  } as unknown as Task
}

function withHome(project: Project, home: Task, remembered = false): Project {
  const [main, ...rest] = project.streams
  return {
    ...project,
    ...(remembered ? { lastStreamId: main.id } : {}),
    streams: [{ ...main, tasks: [home, ...main.tasks], ...(remembered ? { lastTaskId: home.id } : {}) }, ...rest]
  }
}

describe('dropHomeTasks', () => {
  it('drops a Home task holding only its Home tab, and the selection pointing at it', () => {
    const project = withHome(fixtureProject({ id: 'p1', tasks: [{ id: 't1' }] }), homeTask('p1'), true)
    const out = dropHomeTasks(project)
    expect(out.streams[0].tasks.map(t => t.id)).toEqual(['t1'])
    expect(out.streams[0].lastTaskId).toBeUndefined()
    expect(out.lastStreamId).toBeUndefined()
  })

  it('keeps tabs opened in Home as a task with the Home task id', () => {
    const cc: Tab = { id: 'cc', type: 'claude', title: 'Claude Code' }
    const term: Tab = { id: 'term', type: 'terminal', title: 'Terminal' }
    const project = withHome(fixtureProject({ id: 'p1' }), homeTask('p1', [term, cc], 'cc'), true)
    const out = dropHomeTasks(project)
    expect(out.streams[0].tasks).toEqual([{
      id: 'home-task-p1',
      name: 'Home',
      mainTabId: 'cc',
      panes: [{ tabs: [cc, term], activeTabId: 'cc', width: 1 }],
      lastInteractedAt: 1_000
    }])
    expect(out.streams[0].lastTaskId).toBe('home-task-p1')
    expect(out.lastStreamId).toBe(mainStreamId('p1'))
  })

  it('leaves a project without a Home task untouched', () => {
    const project = fixtureProject({ id: 'p1', tasks: [{ id: 't1' }] })
    expect(dropHomeTasks(project)).toBe(project)
  })

  it('runs on load and is idempotent', () => {
    const raw = [withHome(fixtureProject({ id: 'p1', tasks: [{ id: 't1' }] }), homeTask('p1'))]
    const once = migrateProjects(JSON.parse(JSON.stringify(raw)) as unknown[]).projects
    expect(once[0].streams[0].tasks.map(t => t.id)).toEqual(['t1'])
    const twice = migrateProjects(JSON.parse(JSON.stringify(once)) as unknown[]).projects
    expect(twice).toEqual(once)
  })

  it('leaves an ephemeral project with only a Home task spent', () => {
    const project = withHome(fixtureProject({ id: 'x', ephemeral: true }), homeTask('x'))
    expect(isSpentEphemeralProject(dropHomeTasks(project))).toBe(true)
  })
})

describe('Home page selection', () => {
  it('selectProjectHomeView selects the project with no task and opens its notes', () => {
    const next = selectProjectHomeView({ ...createDefaultWindowViewState(), selectedTaskId: 't1' }, 'p1')
    expect(next.selectedProjectId).toBe('p1')
    expect(next.selectedTaskId).toBeNull()
    expect(next.expandedProjectIds).toContain('p1')
    expect(next.fileBrowserOpen).toBe(true)
    expect(next.fileBrowserActiveTab).toBe('notes')
  })

  it('resolveStoredSelection restores Home when no task was remembered', () => {
    const projects = [fixtureProject({ id: 'p1', tasks: [{ id: 't1' }], lastTaskId: 't1' })]
    const result = resolveStoredSelection(projects, { ...DEFAULT_CONFIG, lastProjectId: 'p1', lastTaskId: null })
    expect(result).toEqual({ selectedProjectId: 'p1', selectedTaskId: null })
  })

  it('resolveStoredSelection falls back to the project\'s last task for a stale id, else Home', () => {
    const projects = [fixtureProject({ id: 'p1', tasks: [{ id: 't1' }], lastTaskId: 't1' })]
    expect(resolveStoredSelection(projects, { ...DEFAULT_CONFIG, lastProjectId: 'p1', lastTaskId: 'home-task-p1' }).selectedTaskId).toBe('t1')
    const bare = [fixtureProject({ id: 'p1', tasks: [{ id: 't1' }] })]
    expect(resolveStoredSelection(bare, { ...DEFAULT_CONFIG, lastProjectId: 'p1', lastTaskId: 'gone' }).selectedTaskId).toBeNull()
  })

  it('a tab opened from Home lands in main: its last task, else its first, else nowhere', () => {
    const ws = { worktreePath: '/w', branchName: 'b', baseBranch: 'main', relativeProjectPath: '' }
    const project = fixtureProject({ id: 'p1', tasks: [{ id: 'a' }, { id: 'b' }, { id: 'w', workspace: ws }], lastTaskId: 'w' })
    expect(resolveLandingTaskId(project)).toBe('a')
    const remembered: Project = { ...project, streams: project.streams.map(s => (s.isMain ? { ...s, lastTaskId: 'b' } : s)) }
    expect(resolveLandingTaskId(remembered)).toBe('b')
    expect(resolveLandingTaskId(remembered, 'w')).toBe('w')
    expect(resolveLandingTaskId(fixtureProject({ id: 'p2' }))).toBeNull()
  })
})

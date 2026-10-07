import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  buildWindowViewState,
  reconcileWindowViewState,
  type Project,
  type WindowViewState
} from '../src/shared/types'
import { fixtureProject } from './helpers/streams-fixtures'

describe('window view state', () => {
  const projects: Project[] = [
    fixtureProject({
      id: 'project-1',
      name: 'Project 1',
      directory: '/tmp/project-1',
      lastTaskId: 'task-1',
      tasks: [
        {
          id: 'task-1',
          name: 'Task 1',
          tabs: {
            left: [{ id: 'left-1', type: 'terminal', title: 'Terminal' }],
            right: [{ id: 'right-1', type: 'browser', title: 'Browser', url: 'https://example.com' }]
          },
          activeTab: { left: 'left-1', right: 'right-1' }
        }
      ]
    })
  ]

  it('builds an initial window view state from stored selection', () => {
    const state = buildWindowViewState(
      projects,
      { ...DEFAULT_CONFIG, lastProjectId: 'project-1', lastTaskId: 'task-1' },
      { selectedTagIds: ['tag-1', 'missing-tag'] },
      [{ id: 'tag-1', name: 'work' }]
    )

    expect(state.selectedProjectId).toBe('project-1')
    expect(state.selectedTaskId).toBe('task-1')
    expect(state.selectedTagIds).toEqual(['tag-1'])
  })

  it('prefers a seeded view state when opening a second window', () => {
    const state = buildWindowViewState(projects, DEFAULT_CONFIG, {
      selectedProjectId: 'project-1',
      selectedTaskId: 'task-1',
      taskStates: { 'task-1': { fileBrowserOpen: true, fileBrowserActiveTab: 'git' } }
    })

    expect(state.selectedProjectId).toBe('project-1')
    expect(state.selectedTaskId).toBe('task-1')
    expect(state.taskStates['task-1']).toEqual({ fileBrowserOpen: true, fileBrowserActiveTab: 'git' })
  })

  it('drops the pane fields older builds kept per window, and states of deleted tasks', () => {
    const state = {
      selectedProjectId: 'project-1',
      selectedTaskId: 'task-1',
      selectedTagIds: [],
      expandedProjectIds: [],
      taskStates: {
        'task-1': {
          activeTab: { left: 'missing-tab', right: 'right-1' },
          splitOpen: true,
          splitRatio: 0.75,
          fileBrowserOpen: false
        },
        'deleted-task': { fileBrowserOpen: true }
      }
    } as unknown as WindowViewState

    const next = reconcileWindowViewState(state, projects)

    expect(next.taskStates['task-1']).toEqual({ fileBrowserOpen: false })
    expect(next.taskStates['deleted-task']).toBeUndefined()
  })

  it('seeds expandedProjectIds from the resolved selection when seed has none', () => {
    const state = buildWindowViewState(
      projects,
      { ...DEFAULT_CONFIG, lastProjectId: 'project-1', lastTaskId: 'task-1' }
    )

    expect(state.expandedProjectIds).toEqual(['project-1'])
  })

  it('keeps seeded expandedProjectIds (even when empty)', () => {
    const state = buildWindowViewState(projects, DEFAULT_CONFIG, {
      selectedProjectId: 'project-1',
      selectedTaskId: 'task-1',
      expandedProjectIds: [],
      taskStates: {}
    })

    expect(state.expandedProjectIds).toEqual([])
  })

  it('filters expandedProjectIds to existing projects during reconcile', () => {
    const reconciled = reconcileWindowViewState(
      {
        selectedProjectId: 'project-1',
        selectedTaskId: null,
        selectedTagIds: [],
        expandedProjectIds: ['project-1', 'missing-project'],
        taskStates: {},
        fileBrowserOpen: false,
        fileBrowserWidth: 250,
        fileBrowserActiveTab: 'files'
      } as unknown as WindowViewState,
      projects
    )

    expect(reconciled.expandedProjectIds).toEqual(['project-1'])
  })

  it('opens new windows on the configured default sidebar tab', () => {
    expect(buildWindowViewState(projects, DEFAULT_CONFIG).sidebarTab).toBe('inbox')
    expect(
      buildWindowViewState(projects, { ...DEFAULT_CONFIG, defaultSidebarTab: 'projects' }).sidebarTab
    ).toBe('projects')
  })

  it('keeps a seeded sidebar tab over the configured default', () => {
    const state = buildWindowViewState(projects, DEFAULT_CONFIG, { sidebarTab: 'projects' })

    expect(state.sidebarTab).toBe('projects')
  })
})

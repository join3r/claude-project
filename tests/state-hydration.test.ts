import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Project, type ProjectsData } from '../src/shared/types'
import {
  applyQueuedStateUpdates,
  persistSelectionState,
  resolveInitialSelection
} from '../src/renderer/hooks/stateHydration'

describe('state hydration', () => {
  it('rebases queued project mutations onto loaded projects', () => {
    const loadedProjects: Project[] = [
      { id: 'existing', name: 'Existing', directory: '/tmp/existing', tasks: [] }
    ]

    const addedTaskProjectId = 'existing'
    const nextProjects = applyQueuedStateUpdates(loadedProjects, [
      (prev) => [
        ...prev,
        { id: 'new-project', name: 'New Project', directory: '/tmp/new', tasks: [] }
      ],
      (prev) => prev.map((project) => (
        project.id === addedTaskProjectId
          ? {
              ...project,
              tasks: [{
                id: 'new-task',
                name: 'New Task',
                tabs: { left: [], right: [] },
                activeTab: { left: null, right: null },
                splitOpen: false,
                splitRatio: 0.5
              }]
            }
          : project
      ))
    ])

    expect(nextProjects).toHaveLength(2)
    expect(nextProjects[0].tasks).toHaveLength(1)
    expect(nextProjects[0].tasks[0].id).toBe('new-task')
    expect(nextProjects[1].id).toBe('new-project')
  })

  it('rebases queued config updates onto loaded config', () => {
    const loadedConfig = {
      ...DEFAULT_CONFIG,
      lastProjectId: 'old-project',
      lastTaskId: 'old-task'
    }

    const nextConfig = applyQueuedStateUpdates(loadedConfig, [
      (prev) => ({ ...prev, lastProjectId: 'new-project', lastTaskId: null }),
      (prev) => ({ ...prev, lastTaskId: 'new-task' })
    ])

    expect(nextConfig.lastProjectId).toBe('new-project')
    expect(nextConfig.lastTaskId).toBe('new-task')
  })

  it('does not override an in-memory selection during startup restore', () => {
    const projects: Project[] = [
      { id: 'loaded-project', name: 'Loaded', directory: '/tmp/loaded', tasks: [] }
    ]

    const selection = resolveInitialSelection(
      projects,
      { ...DEFAULT_CONFIG, lastProjectId: 'loaded-project', lastTaskId: 'loaded-task' },
      'new-project',
      'new-task'
    )

    expect(selection.projectId).toBe('new-project')
    expect(selection.taskId).toBe('new-task')
  })

  it('rebases queued ProjectsData mutations onto loaded data', () => {
    const loaded: ProjectsData = {
      projects: [{ id: 'existing', name: 'Existing', directory: '/tmp', tasks: [] }],
      folders: [],
      rootOrder: ['existing']
    }

    const hydrated = applyQueuedStateUpdates(loaded, [
      (prev: ProjectsData) => ({
        ...prev,
        projects: [...prev.projects, { id: 'new', name: 'New', directory: '/tmp/new', tasks: [] }],
        rootOrder: [...prev.rootOrder, 'new']
      })
    ])

    expect(hydrated.projects).toHaveLength(2)
    expect(hydrated.rootOrder).toEqual(['existing', 'new'])
    expect(hydrated.folders).toEqual([])
  })

  it('restores the last valid project and task when nothing is selected yet', () => {
    const projects: Project[] = [
      {
        id: 'loaded-project',
        name: 'Loaded',
        directory: '/tmp/loaded',
        tasks: [{
          id: 'loaded-task',
          name: 'Loaded Task',
          tabs: { left: [], right: [] },
          activeTab: { left: null, right: null },
          splitOpen: false,
          splitRatio: 0.5
        }]
      }
    ]

    const selection = resolveInitialSelection(
      projects,
      { ...DEFAULT_CONFIG, lastProjectId: 'loaded-project', lastTaskId: 'loaded-task' },
      null,
      null
    )

    expect(selection.projectId).toBe('loaded-project')
    expect(selection.taskId).toBe('loaded-task')
  })

  it('persists the selected task onto both config and the owning project', () => {
    const projectsData: ProjectsData = {
      projects: [
        {
          id: 'local-project',
          name: 'Local',
          directory: '/tmp/local',
          tasks: [
            {
              id: 'task-1',
              name: 'Task 1',
              tabs: { left: [], right: [] },
              activeTab: { left: null, right: null },
              splitOpen: false,
              splitRatio: 0.5
            },
            {
              id: 'task-2',
              name: 'Task 2',
              tabs: { left: [], right: [] },
              activeTab: { left: null, right: null },
              splitOpen: false,
              splitRatio: 0.5
            }
          ]
        }
      ],
      folders: [],
      rootOrder: ['local-project']
    }

    const next = persistSelectionState(
      projectsData,
      DEFAULT_CONFIG,
      'local-project',
      'task-2'
    )

    expect(next.config.lastProjectId).toBe('local-project')
    expect(next.config.lastTaskId).toBe('task-2')
    expect(next.projectsData.projects[0].lastTaskId).toBe('task-2')
  })

  it('keeps a project lastTaskId when only the project remains selected', () => {
    const projectsData: ProjectsData = {
      projects: [
        {
          id: 'local-project',
          name: 'Local',
          directory: '/tmp/local',
          lastTaskId: 'task-2',
          tasks: [
            {
              id: 'task-1',
              name: 'Task 1',
              tabs: { left: [], right: [] },
              activeTab: { left: null, right: null },
              splitOpen: false,
              splitRatio: 0.5
            },
            {
              id: 'task-2',
              name: 'Task 2',
              tabs: { left: [], right: [] },
              activeTab: { left: null, right: null },
              splitOpen: false,
              splitRatio: 0.5
            }
          ]
        }
      ],
      folders: [],
      rootOrder: ['local-project']
    }

    const next = persistSelectionState(
      projectsData,
      { ...DEFAULT_CONFIG, lastProjectId: 'local-project', lastTaskId: 'task-2' },
      'local-project',
      null
    )

    expect(next.config.lastProjectId).toBe('local-project')
    expect(next.config.lastTaskId).toBeNull()
    expect(next.projectsData.projects[0].lastTaskId).toBe('task-2')
  })
})

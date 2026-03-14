import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Project } from '../src/shared/types'
import { applyQueuedStateUpdates, resolveInitialSelection } from '../src/renderer/hooks/stateHydration'

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
})

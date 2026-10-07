import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig, type Project, type ProjectsData } from '../src/shared/types'
import {
  applyQueuedStateUpdates,
  persistSelectionState,
  resolveInitialSelection
} from '../src/renderer/hooks/stateHydration'
import { addTaskToStream, projectLastTaskId, projectTasks } from '../src/shared/streams'
import { fixtureProject, fixtureTask } from './helpers/streams-fixtures'

describe('state hydration', () => {
  it('rebases queued project mutations onto loaded projects', () => {
    const loadedProjects: Project[] = [
      fixtureProject({ id: 'existing', name: 'Existing', directory: '/tmp/existing' })
    ]

    const addedTaskProjectId = 'existing'
    const nextProjects = applyQueuedStateUpdates(loadedProjects, [
      (prev) => [
        ...prev,
        fixtureProject({ id: 'new-project', name: 'New Project', directory: '/tmp/new' })
      ],
      (prev) => prev.map((project) => (
        project.id === addedTaskProjectId
          ? addTaskToStream(project, null, fixtureTask({ id: 'new-task', name: 'New Task' }))
          : project
      ))
    ])

    expect(nextProjects).toHaveLength(2)
    expect(projectTasks(nextProjects[0])).toHaveLength(1)
    expect(projectTasks(nextProjects[0])[0].id).toBe('new-task')
    expect(nextProjects[1].id).toBe('new-project')
  })

  it('rebases queued config updates onto loaded config', () => {
    const loadedConfig: AppConfig = {
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
      fixtureProject({ id: 'loaded-project', name: 'Loaded', directory: '/tmp/loaded' })
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
      projects: [fixtureProject({ id: 'existing', name: 'Existing', directory: '/tmp' })],
      tags: [],
      projectOrder: ['existing'],
      pinnedItems: []
    }

    const hydrated = applyQueuedStateUpdates(loaded, [
      (prev: ProjectsData) => ({
        ...prev,
        projects: [...prev.projects, fixtureProject({ id: 'new', name: 'New', directory: '/tmp/new' })],
        projectOrder: [...prev.projectOrder, 'new']
      })
    ])

    expect(hydrated.projects).toHaveLength(2)
    expect(hydrated.projectOrder).toEqual(['existing', 'new'])
    expect(hydrated.tags).toEqual([])
  })

  it('restores the last valid project and task when nothing is selected yet', () => {
    const projects: Project[] = [
      fixtureProject({
        id: 'loaded-project',
        name: 'Loaded',
        directory: '/tmp/loaded',
        tasks: [{ id: 'loaded-task', name: 'Loaded Task' }]
      })
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
        fixtureProject({
          id: 'local-project',
          name: 'Local',
          directory: '/tmp/local',
          tasks: [
            { id: 'task-1', name: 'Task 1' },
            // In a worktree stream of its own, so the stream is remembered too.
            { id: 'task-2', name: 'Task 2', workspace: { worktreePath: '/tmp/wt', branchName: 'b', baseBranch: 'main', relativeProjectPath: '' } }
          ]
        })
      ],
      tags: [],
      projectOrder: ['local-project'],
      pinnedItems: []
    }

    const next = persistSelectionState(
      projectsData,
      DEFAULT_CONFIG,
      'local-project',
      'task-2'
    )

    expect(next.config.lastProjectId).toBe('local-project')
    expect(next.config.lastTaskId).toBe('task-2')
    expect(next.projectsData.projects[0].lastStreamId).toBe('stream-task-2')
    expect(projectLastTaskId(next.projectsData.projects[0])).toBe('task-2')
  })

  it('keeps a project lastTaskId when only the project remains selected', () => {
    const projectsData: ProjectsData = {
      projects: [
        fixtureProject({
          id: 'local-project',
          name: 'Local',
          directory: '/tmp/local',
          lastTaskId: 'task-2',
          tasks: [
            { id: 'task-1', name: 'Task 1' },
            // In a worktree stream of its own, so the stream is remembered too.
            { id: 'task-2', name: 'Task 2', workspace: { worktreePath: '/tmp/wt', branchName: 'b', baseBranch: 'main', relativeProjectPath: '' } }
          ]
        })
      ],
      tags: [],
      projectOrder: ['local-project'],
      pinnedItems: []
    }

    const next = persistSelectionState(
      projectsData,
      { ...DEFAULT_CONFIG, lastProjectId: 'local-project', lastTaskId: 'task-2' },
      'local-project',
      null
    )

    expect(next.config.lastProjectId).toBe('local-project')
    expect(next.config.lastTaskId).toBeNull()
    expect(projectLastTaskId(next.projectsData.projects[0])).toBe('task-2')
  })
})
